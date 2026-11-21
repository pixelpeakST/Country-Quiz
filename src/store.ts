// Local progress store, kept in localStorage. The answer log is append-only and
// every event has a unique id, so devices can swap events without conflicts;
// spaced-repetition cards are rebuilt from the log whenever events are merged.
import { createEmptyCard, fsrs, Rating, State, type Card } from 'ts-fsrs';
import { COUNTRIES, regionCountries, type RegionId } from './countries';

export type Mode = 'find' | 'name';

export interface AnswerEvent {
  id: string; // random, unique per answer
  t: number; // ms timestamp
  country: string;
  mode: Mode;
  correct: boolean;
}

export interface BestScore {
  found: number;
  total: number;
  ms: number;
  at: number;
}

export interface Note {
  text: string; // empty = deleted
  at: number; // last edited, ms
}

interface Data {
  version: 2;
  cards: Record<string, Card>; // key = `${mode}:${countryId}`
  notes: Record<string, Note>; // memory hooks, by country id
  best: Record<string, BestScore>; // key = region id or 'world'
  log: AnswerEvent[];
  /** Ids of log events and keys of notes/scores not yet uploaded. */
  dirty: { events: string[]; notes: string[]; best: string[] };
}

const KEY = 'country-quiz:v1';
// No fuzz, so replaying the same log always gives the same schedule on every device.
// No same-day learning steps: a country comes due again on a later day (a miss the
// next day, a first right answer in about 3 days). Misses are already re-asked at the
// end of the session, so short steps only made "due" pile up while you played.
const scheduler = fsrs({ enable_fuzz: false, enable_short_term: false });
/** Bump when the scheduler settings change, so saved cards are rebuilt from the log. */
const SCHEDULE_VERSION = 2;

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

function load(): Data {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch {
    /* ignore corrupt or unavailable storage */
  }
  return { version: 2, cards: {}, notes: {}, best: {}, log: [], dirty: { events: [], notes: [], best: [] } };
}

/** Upgrade data saved by the first version (no event ids, plain-string notes). */
function migrate(d: any): Data {
  if (d.version === 2) return d as Data;
  const log: AnswerEvent[] = (d.log ?? []).map((e: any) => ({ ...e, id: e.id ?? newId() }));
  const notes: Record<string, Note> = {};
  for (const [k, v] of Object.entries(d.notes ?? {})) notes[k] = { text: String(v), at: Date.now() };
  return {
    version: 2,
    cards: d.cards ?? {},
    notes,
    best: d.best ?? {},
    log,
    dirty: { events: log.map((e) => e.id), notes: Object.keys(notes), best: Object.keys(d.best ?? {}) },
  };
}

const data = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage full or blocked: progress just won't persist */
  }
}

const cardKey = (mode: Mode, id: string) => `${mode}:${id}`;

function getCard(mode: Mode, id: string): Card | undefined {
  const c = data.cards[cardKey(mode, id)];
  if (!c) return undefined;
  return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}

/** Record an answer: updates the spaced-repetition card and the log. */
export function recordAnswer(mode: Mode, id: string, correct: boolean) {
  const ev: AnswerEvent = { id: newId(), t: Date.now(), country: id, mode, correct };
  applyEvent(ev);
  data.log.push(ev);
  data.dirty.events.push(ev.id);
  save();
  notifyChange();
}

function applyEvent(ev: AnswerEvent) {
  const now = new Date(ev.t);
  const card = getCard(ev.mode, ev.country) ?? createEmptyCard<Card>(now);
  const { card: next } = scheduler.next(card, now, ev.correct ? Rating.Good : Rating.Again);
  data.cards[cardKey(ev.mode, ev.country)] = next;
}

/** Rebuild every card by replaying the whole log in time order. */
function rebuildCards() {
  data.log.sort((a, b) => a.t - b.t);
  data.cards = {};
  for (const ev of data.log) applyEvent(ev);
}

// Saved cards from an older schedule are rebuilt from the answer log.
if ((data as any).schedule !== SCHEDULE_VERSION) {
  rebuildCards();
  (data as any).schedule = SCHEDULE_VERSION;
  save();
}

// ---------------------------------------------------------------- Sync hooks

let onChange: (() => void) | null = null;
/** Called after any local change that should be uploaded. */
export function setChangeListener(fn: () => void) {
  onChange = fn;
}
function notifyChange() {
  onChange?.();
}

export function pendingChanges() {
  const ids = new Set(data.dirty.events);
  return {
    events: data.log.filter((e) => ids.has(e.id)),
    notes: data.dirty.notes.map((k) => [k, data.notes[k]] as [string, Note]).filter(([, n]) => n),
    best: data.dirty.best.map((k) => [k, data.best[k]] as [string, BestScore]).filter(([, b]) => b),
  };
}

export function markUploaded(done: { events: string[]; notes: string[]; best: string[] }) {
  const ev = new Set(done.events);
  const no = new Set(done.notes);
  const be = new Set(done.best);
  data.dirty.events = data.dirty.events.filter((id) => !ev.has(id));
  data.dirty.notes = data.dirty.notes.filter((k) => !no.has(k));
  data.dirty.best = data.dirty.best.filter((k) => !be.has(k));
  save();
}

/** Merge data downloaded from the server. Returns true if anything changed. */
export function mergeRemote(remote: { events: AnswerEvent[]; notes: [string, Note][]; best: [string, BestScore][] }) {
  let changed = false;
  const have = new Set(data.log.map((e) => e.id));
  const fresh = remote.events.filter((e) => !have.has(e.id));
  if (fresh.length) {
    data.log.push(...fresh);
    rebuildCards();
    changed = true;
  }
  for (const [k, n] of remote.notes) {
    const mine = data.notes[k];
    if (!mine || n.at > mine.at) {
      data.notes[k] = n;
      changed = true;
    }
  }
  for (const [k, b] of remote.best) {
    if (isBetter(b, data.best[k])) {
      data.best[k] = b;
      changed = true;
    }
  }
  if (changed) save();
  return changed;
}

/** Wipe answers and scores locally (the caller also wipes the server copy). */
export function clearLocalProgress() {
  data.cards = {};
  data.best = {};
  data.log = [];
  data.dirty.events = [];
  data.dirty.best = [];
  save();
  try {
    localStorage.removeItem(ACTIVE_KEY);
  } catch {
    /* ignore */
  }
}

/** A country counts as "learned" once it has graduated to review and was last answered right. */
export function isLearned(mode: Mode, id: string): boolean {
  const c = getCard(mode, id);
  // In review and last answered right (a miss schedules it for the next day).
  return !!c && c.state === State.Review && c.scheduled_days >= 2;
}

/**
 * End of today in local time. Reviews are counted by day, not by the minute: a
 * country answered at 7 pm three days ago is due all of today, not only after 7 pm.
 * Counting by the minute made new countries trickle into "due" while you played,
 * at the same pace you answered them a few days earlier, so the count never dropped.
 */
function dueCutoff(now = Date.now()) {
  const d = new Date(now);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

const isDue = (card: Card, cutoff = dueCutoff()) => card.due.getTime() <= cutoff;

export function regionProgress(region: RegionId, mode: Mode = 'find') {
  const list = regionCountries(region);
  const learned = list.filter((c) => isLearned(mode, c.id)).length;
  const cutoff = dueCutoff();
  const due = list.filter((c) => {
    const card = getCard(mode, c.id);
    return card && isDue(card, cutoff);
  }).length;
  return { learned, due, total: list.length };
}

export function totalLearned(mode: Mode = 'find') {
  return COUNTRIES.filter((c) => isLearned(mode, c.id)).length;
}

/**
 * Pick a practice session for a region: due reviews first (most overdue first),
 * then up to `newLimit` unseen countries. Spare slots alternate between the
 * weakest countries and the ones you haven't seen for longest, so learned
 * countries still come back now and then instead of the same weak few every time.
 */
export function pickSession(region: RegionId | 'world', mode: Mode, size = 10, newLimit = 5): string[] {
  const cutoff = dueCutoff();
  const pool = region === 'world' ? COUNTRIES : regionCountries(region);
  const seen: { id: string; card: Card }[] = [];
  const unseen: string[] = [];
  for (const c of pool) {
    const card = getCard(mode, c.id);
    if (card) seen.push({ id: c.id, card });
    else unseen.push(c.id);
  }
  const due = seen.filter((s) => isDue(s.card, cutoff)).sort((a, b) => a.card.due.getTime() - b.card.due.getTime());
  const picked = due.slice(0, size).map((s) => s.id);
  for (const id of shuffle(unseen).slice(0, Math.min(newLimit, size - picked.length))) picked.push(id);
  if (picked.length < size) {
    const rest = seen.filter((s) => !picked.includes(s.id));
    const weakest = rest.slice().sort((a, b) => a.card.stability - b.card.stability);
    const lastSeen = (s: { card: Card }) => s.card.last_review?.getTime() ?? 0;
    const oldest = rest.slice().sort((a, b) => lastSeen(a) - lastSeen(b));
    for (let i = 0; picked.length < size && (weakest.length || oldest.length); i++) {
      const from = i % 2 === 0 ? weakest : oldest;
      const next = from.shift() ?? (from === weakest ? oldest : weakest).shift();
      if (next && !picked.includes(next.id)) picked.push(next.id);
    }
  }
  if (picked.length < size) {
    picked.push(...shuffle(unseen.filter((id) => !picked.includes(id))).slice(0, size - picked.length));
  }
  return shuffle(picked);
}

export function getNote(id: string) {
  return data.notes[id]?.text ?? '';
}

export function setNote(id: string, text: string) {
  data.notes[id] = { text: text.trim(), at: Date.now() };
  if (!data.dirty.notes.includes(id)) data.dirty.notes.push(id);
  save();
  notifyChange();
}

export function getBest(key: string): BestScore | undefined {
  return data.best[key];
}

/** Saves the score if it beats the previous best (more found, or same found faster). */
function isBetter(score: BestScore, prev: BestScore | undefined) {
  return !prev || score.found > prev.found || (score.found === prev.found && score.ms < prev.ms);
}

export function submitScore(key: string, score: BestScore): boolean {
  const better = isBetter(score, data.best[key]);
  if (better) {
    data.best[key] = score;
    if (!data.dirty.best.includes(key)) data.dirty.best.push(key);
    save();
    notifyChange();
  }
  return better;
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- Recent and stats

const RECENT_KEY = 'country-quiz:recent';

/** Remember the region (or 'world') opened most recently on this device. */
export function setRecent(scope: RegionId | 'world') {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify({ scope, at: Date.now() }));
  } catch {
    /* not important if it can't be saved */
  }
}

export function getRecent(): { scope: RegionId | 'world'; at: number } | null {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export interface ModeStats {
  answers: number;
  correct: number;
}

export interface RegionStats {
  total: number;
  learned: number;
  due: number;
  seen: number;
  find: ModeStats;
  name: ModeStats;
  lastPlayed: number | null;
  /** Countries missed most often (most misses first), at most 5. */
  hardest: { id: string; misses: number; answers: number }[];
  /** Next time something becomes due, if nothing is due now. */
  nextDue: number | null;
}

export function regionStats(region: RegionId | 'world'): RegionStats {
  const list = region === 'world' ? COUNTRIES : regionCountries(region);
  const ids = new Set(list.map((c) => c.id));
  const find: ModeStats = { answers: 0, correct: 0 };
  const name: ModeStats = { answers: 0, correct: 0 };
  const per = new Map<string, { misses: number; answers: number }>();
  let lastPlayed: number | null = null;
  for (const e of data.log) {
    if (!ids.has(e.country)) continue;
    const m = e.mode === 'find' ? find : name;
    m.answers++;
    if (e.correct) m.correct++;
    const p = per.get(e.country) ?? { misses: 0, answers: 0 };
    p.answers++;
    if (!e.correct) p.misses++;
    per.set(e.country, p);
    if (lastPlayed === null || e.t > lastPlayed) lastPlayed = e.t;
  }
  const hardest = [...per.entries()]
    .filter(([, p]) => p.misses > 0)
    .sort((a, b) => b[1].misses - a[1].misses || b[1].misses / b[1].answers - a[1].misses / a[1].answers)
    .slice(0, 5)
    .map(([id, p]) => ({ id, ...p }));
  const cutoff = dueCutoff();
  let due = 0;
  let nextDue: number | null = null;
  for (const c of list) {
    const card = getCard('find', c.id);
    if (!card) continue;
    const t = card.due.getTime();
    if (t <= cutoff) due++;
    else if (nextDue === null || t < nextDue) nextDue = t;
  }
  return {
    total: list.length,
    learned: list.filter((c) => isLearned('find', c.id)).length,
    due,
    seen: per.size,
    find,
    name,
    lastPlayed,
    hardest,
    nextDue: due ? null : nextDue,
  };
}

// ---------------------------------------------------------------- Activity and streaks

const ACTIVE_KEY = 'country-quiz:active-days'; // days with a timed challenge (those aren't in the answer log)
const CELEBRATED_KEY = 'country-quiz:celebrated';
const DAY = 86_400_000;

/** Local calendar day as a number (days since epoch in local time). */
const dayOf = (t: number) => {
  const d = new Date(t);
  return Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY);
};

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** Note activity that isn't an answer (a timed challenge). */
export function markActive(at = Date.now()) {
  const list = readJSON<number[]>(ACTIVE_KEY, []);
  list.push(at);
  writeJSON(ACTIVE_KEY, list.slice(-500));
}

export interface Activity {
  /** Answers per day for the last `days` days, oldest first; last entry is today. */
  perDay: { day: number; count: number }[];
  /** Consecutive active days ending today, or yesterday if today is still open. */
  streak: number;
  /** True when the streak counts today. */
  doneToday: boolean;
  best: number;
  lastAt: number | null;
  /** Local day number of today, for labeling. */
  today: number;
}

export function activity(days = 14): Activity {
  const counts = new Map<number, number>();
  let lastAt: number | null = null;
  const bump = (t: number, n: number) => {
    const d = dayOf(t);
    counts.set(d, (counts.get(d) ?? 0) + n);
    if (lastAt === null || t > lastAt) lastAt = t;
  };
  for (const e of data.log) bump(e.t, 1);
  for (const t of readJSON<number[]>(ACTIVE_KEY, [])) bump(t, 0);
  const today = dayOf(Date.now());
  const perDay = Array.from({ length: days }, (_, i) => {
    const day = today - (days - 1 - i);
    return { day, count: counts.get(day) ?? 0 };
  });
  const doneToday = counts.has(today);
  let streak = 0;
  for (let d = doneToday ? today : today - 1; counts.has(d); d--) streak++;
  // Longest run ever.
  let best = 0;
  let run = 0;
  let prev = NaN;
  for (const d of [...counts.keys()].sort((a, b) => a - b)) {
    run = d === prev + 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { perDay, streak, doneToday, best, lastAt, today };
}

/** Streak milestones: 3, 5, 10, 15, 20, ... */
export const isMilestone = (n: number) => n === 3 || (n >= 5 && n % 5 === 0);

/**
 * Returns the streak to celebrate if today just reached a milestone that hasn't
 * been celebrated yet for this streak, and remembers it.
 */
export function streakToCelebrate(): number | null {
  const a = activity(1);
  if (!a.doneToday || !isMilestone(a.streak)) return null;
  const startDay = a.today - a.streak + 1;
  const key = `${startDay}:${a.streak}`;
  const done = readJSON<string[]>(CELEBRATED_KEY, []);
  if (done.includes(key)) return null;
  writeJSON(CELEBRATED_KEY, [...done, key].slice(-50));
  return a.streak;
}
