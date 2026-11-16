// Sign-in (email and password) and two-way sync with Supabase.
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './config';
import {
  clearLocalProgress, markUploaded, mergeRemote, pendingChanges, setChangeListener,
  type AnswerEvent, type BestScore, type Note,
} from './store';

export const syncEnabled = !!(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);

let client: SupabaseClient | null = null;
let user: User | null = null;
let syncing: Promise<void> | null = null;
let again = false;
let timer = 0;
let status: 'off' | 'idle' | 'syncing' | 'error' | 'offline' = 'off';
let lastError = '';
const listeners = new Set<() => void>();

const PULL_KEY = 'country-quiz:last-pull';
const PAGE = 1000;

function emit() {
  for (const fn of listeners) fn();
}

/** Subscribe to sign-in/sync status changes. Returns an unsubscribe function. */
export function onSyncState(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function syncState() {
  return { enabled: syncEnabled, email: user?.email ?? null, status, error: lastError };
}

/** Called once at start-up. `onRemoteChange` re-renders when other devices' progress arrives. */
export async function initSync(onRemoteChange: () => void) {
  if (!syncEnabled) return;
  client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  remoteChanged = onRemoteChange;
  client.auth.onAuthStateChange((_event, session) => {
    const was = user?.id;
    user = session?.user ?? null;
    status = user ? 'idle' : 'off';
    emit();
    if (user && user.id !== was) syncNow();
  });
  const { data } = await client.auth.getSession();
  user = data.session?.user ?? null;
  status = user ? 'idle' : 'off';
  emit();
  setChangeListener(() => {
    clearTimeout(timer);
    timer = window.setTimeout(syncNow, 4000);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' || document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('online', () => syncNow());
  if (user) syncNow();
}

let remoteChanged: () => void = () => {};

/** Sign in to an existing account. */
export async function signIn(email: string, password: string) {
  if (!client) throw new Error('Sign-in is not set up.');
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

/**
 * Create an account. Returns 'signed-in', or 'confirm-email' when Supabase
 * wants the address confirmed first (tap the link in the email, then sign in).
 */
export async function signUp(email: string, password: string): Promise<'signed-in' | 'confirm-email'> {
  if (!client) throw new Error('Sign-in is not set up.');
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) throw error;
  return data.session ? 'signed-in' : 'confirm-email';
}

export async function signOut() {
  await syncNow();
  await client?.auth.signOut();
  localStorage.removeItem(PULL_KEY);
}

/** Upload local changes, then download changes from other devices. */
export function syncNow(): Promise<void> {
  if (!client || !user) return Promise.resolve();
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      again = false;
      if (!navigator.onLine) {
        status = 'offline';
        break;
      }
      status = 'syncing';
      emit();
      try {
        await push();
        if (await pull()) remoteChanged();
        status = 'idle';
        lastError = '';
      } catch (e: any) {
        status = 'error';
        lastError = e?.message ?? String(e);
        console.warn('Sync failed', e);
        break;
      }
    } while (again);
  })().finally(() => {
    syncing = null;
    emit();
  });
  return syncing;
}

async function push() {
  const db = client!;
  const p = pendingChanges();
  if (p.events.length) {
    for (let i = 0; i < p.events.length; i += 500) {
      const rows = p.events.slice(i, i + 500).map((e) => ({ id: e.id, t: e.t, country: e.country, mode: e.mode, correct: e.correct }));
      const { error } = await db.from('answers').upsert(rows, { onConflict: 'user_id,id', ignoreDuplicates: true });
      if (error) throw error;
    }
  }
  if (p.notes.length) {
    const { error } = await db
      .from('notes')
      .upsert(p.notes.map(([country, n]) => ({ country, text: n.text, at: n.at })), { onConflict: 'user_id,country' });
    if (error) throw error;
  }
  if (p.best.length) {
    // Only overwrite the server's best if ours is better.
    const { data: theirs, error: readErr } = await db.from('best_scores').select('scope,found,total,ms,at');
    if (readErr) throw readErr;
    const remote = new Map((theirs ?? []).map((r: any) => [r.scope, r]));
    const rows = p.best
      .filter(([scope, b]) => {
        const r = remote.get(scope);
        return !r || b.found > r.found || (b.found === r.found && b.ms < r.ms);
      })
      .map(([scope, b]) => ({ scope, ...b }));
    if (rows.length) {
      const { error } = await db.from('best_scores').upsert(rows, { onConflict: 'user_id,scope' });
      if (error) throw error;
    }
  }
  markUploaded({ events: p.events.map((e) => e.id), notes: p.notes.map(([k]) => k), best: p.best.map(([k]) => k) });
}

async function pull(): Promise<boolean> {
  const db = client!;
  const since = localStorage.getItem(PULL_KEY);
  const events: AnswerEvent[] = [];
  let newest = since ?? '';
  // Page through answers added since the last pull (a few seconds of overlap; duplicates are ignored).
  let from = since ? new Date(new Date(since).getTime() - 10_000).toISOString() : '1970-01-01T00:00:00Z';
  for (;;) {
    const { data, error } = await db
      .from('answers')
      .select('id,t,country,mode,correct,created_at')
      .gte('created_at', from)
      .order('created_at', { ascending: true })
      .limit(PAGE);
    if (error) throw error;
    for (const r of data ?? []) {
      events.push({ id: r.id, t: Number(r.t), country: r.country, mode: r.mode, correct: r.correct });
      if (r.created_at > newest) newest = r.created_at;
    }
    if (!data || data.length < PAGE) break;
    from = data[data.length - 1].created_at;
  }
  const [{ data: notes, error: nErr }, { data: best, error: bErr }] = await Promise.all([
    db.from('notes').select('country,text,at'),
    db.from('best_scores').select('scope,found,total,ms,at'),
  ]);
  if (nErr) throw nErr;
  if (bErr) throw bErr;
  const changed = mergeRemote({
    events,
    notes: (notes ?? []).map((n: any) => [n.country, { text: n.text, at: Number(n.at) } as Note]),
    best: (best ?? []).map((b: any) => [b.scope, { found: b.found, total: b.total, ms: Number(b.ms), at: Number(b.at) } as BestScore]),
  });
  if (newest) localStorage.setItem(PULL_KEY, newest);
  return changed;
}

/** Erase answers and best scores on this device and, when signed in, on the server. */
export async function resetEverywhere() {
  if (client && user) {
    const a = await client.from('answers').delete().eq('user_id', user.id);
    if (a.error) throw a.error;
    const b = await client.from('best_scores').delete().eq('user_id', user.id);
    if (b.error) throw b.error;
  }
  clearLocalProgress();
}
