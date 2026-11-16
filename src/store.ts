// Local progress store. Everything lives in localStorage for now; the answer
// log is append-only so it can later be synced to a server without conflicts.
import { createEmptyCard, fsrs, Rating, State, type Card } from 'ts-fsrs';
import { COUNTRIES, regionCountries, type RegionId } from './countries';

export type Mode = 'find' | 'name';

export interface AnswerEvent {
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

interface Data {
  version: 1;
  cards: Record<string, Card>; // key = `${mode}:${countryId}`
  notes: Record<string, string>; // memory hooks, by country id
  best: Record<string, BestScore>; // key = region id or 'world'
  log: AnswerEvent[];
}

const KEY = 'country-quiz:v1';
const scheduler = fsrs({ enable_fuzz: true });

function load(): Data {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Data;
  } catch {
    /* ignore corrupt or unavailable storage */
  }
  return { version: 1, cards: {}, notes: {}, best: {}, log: [] };
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
  const now = new Date();
  const card = getCard(mode, id) ?? createEmptyCard<Card>(now);
  const { card: next } = scheduler.next(card, now, correct ? Rating.Good : Rating.Again);
  data.cards[cardKey(mode, id)] = next;
  data.log.push({ t: now.getTime(), country: id, mode, correct });
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
  return data.notes[id] ?? '';
}

export function setNote(id: string, text: string) {
  if (text.trim()) data.notes[id] = text.trim();
  else delete data.notes[id];
  save();
}

export function getBest(key: string): BestScore | undefined {
  return data.best[key];
}

/** Saves the score if it beats the previous best (more found, or same found faster). */
export function submitScore(key: string, score: BestScore): boolean {
  const prev = data.best[key];
  const better = !prev || score.found > prev.found || (score.found === prev.found && score.ms < prev.ms);
  if (better) {
    data.best[key] = score;
    save();
  }
  return better;
}

export function resetProgress() {
  data.cards = {};
  data.best = {};
  data.log = [];
  save();
}

export function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
