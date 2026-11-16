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
const scheduler = fsrs({ enable_fuzz: false });

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
}

/** A country counts as "learned" once it has graduated to review and was last answered right. */
export function isLearned(mode: Mode, id: string): boolean {
  const c = getCard(mode, id);
  return !!c && c.state === State.Review;
}

export function regionProgress(region: RegionId, mode: Mode = 'find') {
  const list = regionCountries(region);
  const learned = list.filter((c) => isLearned(mode, c.id)).length;
  const due = list.filter((c) => {
    const card = getCard(mode, c.id);
    return card && card.due.getTime() <= Date.now();
  }).length;
  return { learned, due, total: list.length };
}

export function totalLearned(mode: Mode = 'find') {
  return COUNTRIES.filter((c) => isLearned(mode, c.id)).length;
}

/**
 * Pick a practice session for a region: due reviews first (most overdue first),
 * then up to `newLimit` unseen countries, topped up with the weakest ones.
 */
export function pickSession(region: RegionId | 'world', mode: Mode, size = 10, newLimit = 5): string[] {
  const now = Date.now();
  const pool = region === 'world' ? COUNTRIES : regionCountries(region);
  const seen: { id: string; card: Card }[] = [];
  const unseen: string[] = [];
  for (const c of pool) {
    const card = getCard(mode, c.id);
    if (card) seen.push({ id: c.id, card });
    else unseen.push(c.id);
  }
  const due = seen.filter((s) => s.card.due.getTime() <= now).sort((a, b) => a.card.due.getTime() - b.card.due.getTime());
  const picked = due.slice(0, size).map((s) => s.id);
  for (const id of shuffle(unseen).slice(0, Math.min(newLimit, size - picked.length))) picked.push(id);
  if (picked.length < size) {
    // Top up with the least stable cards that aren't already picked.
    const rest = seen
      .filter((s) => !picked.includes(s.id))
      .sort((a, b) => a.card.stability - b.card.stability)
      .map((s) => s.id);
    picked.push(...rest.slice(0, size - picked.length));
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
