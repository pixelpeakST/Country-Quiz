import '@fontsource/lilita-one/latin-400.css';
import '@fontsource/sniglet/latin-400.css';
import '@fontsource/sniglet/latin-800.css';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-600.css';
import '@fontsource/nunito/latin-700.css';
import './style.css';
import { REGION_ART } from './regionArt';
import { COUNTRIES, COUNTRY_BY_ID, matchAnswer, normalizeAnswer, REGIONS, regionCountries, type RegionId } from './countries';
import { WorldMap } from './map';
import {
  activity, getBest, getNote, getRecent, markActive, pickSession, streakToCelebrate, recordAnswer, regionProgress, regionStats, setNote, setRecent, shuffle,
  submitScore, totalLearned, type Mode,
} from './store';
import { initSync, onSyncState, resetEverywhere, signIn, signOut, signUp, syncNow, syncState } from './sync';

type Scope = RegionId | 'world';

const app = document.getElementById('app')!;
let cleanup: (() => void) | null = null;

/** Tiny DOM helper: h('div.card', {onclick}, children...) */
function h<K extends keyof HTMLElementTagNameMap>(
  tag: `${K}${string}`,
  props: Record<string, any> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name) as HTMLElementTagNameMap[K];
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (v !== undefined && v !== false) (el as any)[k] = v;
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

let onHome = false;

function show(...nodes: Node[]) {
  cleanup?.();
  cleanup = null;
  onHome = false;
  app.replaceChildren(...nodes);
  window.scrollTo(0, 0);
}

const scopeName = (s: Scope) => (s === 'world' ? 'Whole world' : REGIONS.find((r) => r.id === s)!.name);
const scopeCountries = (s: Scope) => (s === 'world' ? COUNTRIES : regionCountries(s));

function topBar(title: string, back?: () => void, right?: Node, left?: Node) {
  return h(
    'header.bar',
    {},
    back ? h('button.icon', { onclick: back, ariaLabel: 'Back', textContent: '‹' }) : left ?? h('span.icon-spacer'),
    h('h1', { textContent: title }),
    right ?? h('span.icon-spacer'),
  );
}

function progressBar(value: number, total: number) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return h('div.progress', { role: 'progressbar', ariaValueNow: String(pct) }, h('div', { style: `width:${pct}%` }));
}

function timeAgo(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = Math.round(hr / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function timeUntil(t: number) {
  const s = Math.max(0, (t - Date.now()) / 1000);
  const hr = s / 3600;
  if (hr < 1) return 'within the hour';
  if (hr < 24) return `in ${Math.round(hr)} hour${Math.round(hr) === 1 ? '' : 's'}`;
  const d = Math.round(hr / 24);
  return d === 1 ? 'tomorrow' : `in ${d} days`;
}

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '–');

function fmtTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Home

function home() {
  const learned = totalLearned();
  const worldBest = getBest('world');
  show(
    topBar('Country Quiz', undefined, undefined, h('button.icon.menu-btn', { type: 'button', ariaLabel: 'Menu', textContent: '☰', onclick: sideMenu })),
    h(
      'main.home',
      {},
      h(
        'section.hero',
        {},
        h('div.big', { textContent: `${learned} / ${COUNTRIES.length}` }),
        h('div.muted', { textContent: 'countries you can find on the map' }),
        progressBar(learned, COUNTRIES.length),
      ),
      tipLine(),
      h(
        'div.regions',
        {},
        recentCard(),
        ...REGIONS.map((r) => {
          const p = regionProgress(r.id);
          const best = getBest(r.id);
          return regionCard(
            r.id,
            h('div.row', {}, h('strong', { textContent: r.name }), p.due ? h('span.badge', { textContent: `${p.due} due` }) : null),
            h('div.muted.small', { textContent: `${p.learned} of ${p.total} learned${best ? ` · best ${best.found}/${best.total}` : ''}` }),
            progressBar(p.learned, p.total),
          );
        }),
        regionCard(
          'world',
          h('strong', { textContent: 'Whole world' }),
          h('div.muted.small', {
            textContent: worldBest ? `Best: ${worldBest.found}/${worldBest.total} in ${fmtTime(worldBest.ms)}` : 'Timed quiz on all 197 countries',
          }),
        ),
      ),
    ),
  );
  onHome = true;
  celebrateIfStreak(600);
}

// ---------------------------------------------------------------- Home pieces

const TIP_REST =
  'Learn one region at a time. Explore the map, practice until it sticks, then try the timed challenge. Come back every couple of days for reviews.';

function tipLine() {
  const tip = h('div.tip', {});
  const info = <HTMLButtonElement>h('button.info', { type: 'button', ariaLabel: 'How to study', ariaExpanded: 'false', textContent: 'i' });
  info.addEventListener('click', () => {
    const open = tip.classList.toggle('open');
    info.ariaExpanded = String(open);
  });
  tip.append(
    h('div.tip-head', {}, info, h('p', { textContent: 'One at a time' })),
    h('div.tip-more', {}, h('div', {}, h('p', { textContent: TIP_REST }))),
  );
  return tip;
}

/** Simple silhouette of a region, sized to fit its card. */
function regionArt(scope: Scope) {
  const a = REGION_ART[scope];
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${a.w} ${a.h}`);
  svg.setAttribute('class', 'region-art');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.aspectRatio = `${a.w} / ${a.h}`;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', a.d);
  svg.append(path);
  return svg;
}

function regionCard(scope: Scope, ...content: (Node | null)[]) {
  return h(
    `button.region-card${scope === 'world' ? '.world' : ''}`,
    { type: 'button', onclick: () => regionMenu(scope) },
    h('div.card-body', {}, ...content),
    regionArt(scope),
  );
}

function recentCard() {
  const r = getRecent();
  if (!r) return null;
  const p = r.scope === 'world' ? null : regionProgress(r.scope);
  return h(
    'button.region-card.recent',
    { type: 'button', onclick: () => regionMenu(r.scope) },
    h(
      'div.card-body',
      {},
      h('span.eyebrow', { textContent: 'Recent' }),
      h('div.row', {}, h('strong', { textContent: scopeName(r.scope) }), p?.due ? h('span.badge', { textContent: `${p.due} due` }) : null),
      h('div.muted.small', { textContent: `Opened ${timeAgo(r.at)}${p ? ` · ${p.learned} of ${p.total} learned` : ''}` }),
      p ? progressBar(p.learned, p.total) : null,
    ),
    regionArt(r.scope),
  );
}

let closeDrawer: () => void = () => {};

/** Slide-in panel from the left over a blurred backdrop (stats, side menu). */
function openDrawer(label: string, eyebrow: string, title: string, ...content: (Node | null)[]) {
  closeDrawer();
  const opener = document.activeElement as HTMLElement | null;
  const close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.classList.add('closing');
    setTimeout(() => backdrop.remove(), 200);
    closeDrawer = () => {};
    opener?.focus();
  };
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
  const closeBtn = h('button.icon.close', { type: 'button', ariaLabel: 'Close', textContent: '✕', onclick: close });
  const drawer = h(
    'aside.drawer',
    { role: 'dialog', ariaModal: 'true', ariaLabel: label, onclick: (e: Event) => e.stopPropagation() },
    h('div.drawer-head', {}, h('div', {}, h('span.eyebrow', { textContent: eyebrow }), h('h2', { textContent: title })), closeBtn),
    ...content,
  );
  const backdrop = h('div.sheet-backdrop', { onclick: close }, drawer);
  document.addEventListener('keydown', onKey);
  document.body.append(backdrop);
  closeDrawer = close;
  closeBtn.focus();
}

/** Side menu. Settings live here; add new settings to this section. */
function sideMenu() {
  openDrawer(
    'Menu',
    'Country Quiz',
    'Menu',
    activityPanel(),
    h(
      'section.settings',
      {},
      h('h3', { textContent: 'Settings' }),
      accountDropdown(),
      h('div.setting-group', {}, h('span.setting-label', { textContent: 'Progress' }), resetButton()),
    ),
  );
}

// ---------------------------------------------------------------- Activity, streaks, celebrations

const DAY_LETTERS = ['s', 'm', 't', 'w', 't', 'f', 's'];
// Day numbers are local midnights rounded to whole days, so the UTC weekday of day * 24h is the local weekday.
const dayLetter = (day: number) => DAY_LETTERS[new Date(day * 86_400_000).getUTCDay()];

function activityPanel() {
  const a = activity(14);
  const week = a.perDay.slice(-7);
  const max = Math.max(1, ...a.perDay.map((d) => d.count));
  const thisWeek = week.reduce((n, d) => n + d.count, 0);
  const activeDays = a.perDay.filter((d) => d.count > 0).length;

  const streakCard = a.streak
    ? h(
        'div.streak-card.on',
        {},
        flameIcon('flame'),
        h('div', {},
          streakTitle(a.streak, 'streak-num'),
          h('div.muted.small', { textContent: a.doneToday ? 'you practiced today. see you tomorrow!' : 'practice today to keep it going' }),
        ),
      )
    : h(
        'div.streak-card',
        {},
        flameIcon('flame.off'),
        h('div', {},
          h('div.streak-num', { textContent: a.lastAt ? `last practice ${timeAgo(a.lastAt)}` : 'no practice yet' }),
          h('div.muted.small', { textContent: 'practice today to start a streak' }),
        ),
      );

  const days = h(
    'div.day-tracker',
    { role: 'list', ariaLabel: 'last 7 days' },
    ...week.map((d, i) =>
      h(
        `div.day${d.count || (i === 6 && a.doneToday) ? '.done' : ''}${i === 6 ? '.today' : ''}`,
        { role: 'listitem', ariaLabel: `${d.count} answers`, style: `--i:${i}` },
        h('span.day-dot', { textContent: d.count ? '✓' : '' }),
        h('span.day-letter', { textContent: dayLetter(d.day) }),
      ),
    ),
  );

  const bars = h(
    'div.bars',
    { role: 'img', ariaLabel: `answers per day for the last 14 days, ${thisWeek} this week` },
    ...a.perDay.map((d, i) =>
      h(
        `div.bar-col${i === a.perDay.length - 1 ? '.today' : ''}`,
        {},
        h(`div.bar${d.count ? '' : '.zero'}`, {
          title: `${d.count} answers`,
          // Each bar grows at its own pace.
          style: `height:${d.count ? Math.max(6, (d.count / max) * 100) : 3}%;--dur:${(0.55 + Math.random() * 0.7).toFixed(2)}s;--delay:${(0.1 + i * 0.03).toFixed(2)}s`,
        }),
        h('span.bar-label', { textContent: dayLetter(d.day) }),
      ),
    ),
  );

  return h(
    'section.activity',
    {},
    streakCard,
    days,
    h('div.activity-stats', {},
      h('div', {}, h('strong', { textContent: String(thisWeek) }), h('span.muted.small', { textContent: 'answers in 7 days' })),
      h('div', {}, h('strong', { textContent: `${activeDays}/14` }), h('span.muted.small', { textContent: 'days active' })),
      h('div', {}, h('strong', { textContent: String(a.best) }), h('span.muted.small', { textContent: 'best streak' })),
    ),
    h('h3', { textContent: 'last two weeks' }),
    bars,
  );
}

/** Flame in the app icon's style: a rounded tile, a flame and a green dot. Colors flip with the theme. */
function flameIcon(cls: string) {
  const wrap = h(`span.${cls}`, { ariaHidden: 'true' });
  wrap.innerHTML =
    '<svg viewBox="15 5 34 52" class="flame-svg"><rect width="64" height="64" rx="14" class="flame-tile"/>' +
    '<path class="flame-shape" d="M32 7c1.5 9 15 15.5 15 31a15 15 0 0 1-30 0c0-8.5 4-13.5 7.5-17 .6 5 2.6 8 6 9.5C28.5 21.5 29 13 32 7z"/>' +
    '<circle class="flame-dot" cx="32" cy="41" r="6.5"/></svg>';
  return wrap;
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** "five", "twenty-one", "one hundred"; past 100 it stays a number. */
function numberWord(n: number): string {
  if (n > 100 || n < 0) return String(n);
  if (n === 100) return 'one hundred';
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
}

/** A tall, skinny exclamation mark with rounded ends, drawn so it can match the text height. */
function bangMark() {
  const wrap = h('span.bang', { ariaHidden: 'true' });
  wrap.innerHTML =
    '<svg viewBox="0 0 12 60" preserveAspectRatio="xMidYMax meet">' +
    '<path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.6L8.2 40.2a2.2 2.2 0 0 1-4.4 0L1.5 6.1A4.5 4.5 0 0 1 6 1.5z"/>' +
    '<circle cx="6" cy="54.2" r="4.3"/></svg>';
  return wrap;
}

/** "five" centered above "day streak" (or "101 day streak" on one line past 100). */
function streakTitle(n: number, cls: string, bang = false) {
  const text = n > 100
    ? h('span.streak-lines', {}, h('span', { textContent: `${n} day streak` }))
    : h('span.streak-lines', {}, h('span.streak-word', { textContent: numberWord(n) }), h('span', { textContent: 'day streak' }));
  return h(`div.${cls}`, {}, text, bang ? bangMark() : null);
}

function celebrateIfStreak(delay: number) {
  const n = streakToCelebrate();
  if (n) setTimeout(() => celebrate(n), delay);
}

/** A little popping celebration for streak milestones. */
function celebrate(n: number) {
  const colors = ['var(--accent)', 'var(--target)', 'var(--good)', '#ff8fb1', '#7cc6ff'];
  const burst = h('div.burst', { ariaHidden: 'true' });
  for (let i = 0; i < 26; i++) {
    const angle = (i / 26) * Math.PI * 2 + Math.random() * 0.4;
    const dist = 90 + Math.random() * 90;
    burst.append(
      h(`span.confetti${i % 3 === 0 ? '.round' : ''}`, {
        style: `--x:${(Math.cos(angle) * dist).toFixed(0)}px;--y:${(Math.sin(angle) * dist).toFixed(0)}px;--r:${Math.round(Math.random() * 540 - 270)}deg;background:${colors[i % colors.length]};animation-delay:${(Math.random() * 0.12).toFixed(2)}s`,
      }),
    );
  }
  const el = h(
    'div.celebrate',
    { role: 'status' },
    burst,
    h('div.celebrate-card', {},
      flameIcon('celebrate-emoji'),
      streakTitle(n, 'celebrate-num', true),
      h('div.muted', { textContent: n === 3 ? 'nice start, keep it rolling' : 'you are on fire' }),
    ),
  );
  const close = () => {
    el.classList.add('closing');
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', close);
  document.body.append(el);
  setTimeout(close, 3200);
}

function resetButton() {
  return h('button.link.danger', {
          textContent: 'Reset progress',
          onclick: async (e: Event) => {
            const btn = e.currentTarget as HTMLButtonElement;
            if (!btn.dataset.armed) {
              btn.dataset.armed = '1';
              btn.textContent = syncState().email
                ? 'Tap again to erase all progress on every device (memory hooks are kept)'
                : 'Tap again to erase all progress (memory hooks are kept)';
              return;
            }
            btn.disabled = true;
            try {
              await resetEverywhere();
              closeDrawer();
              home();
            } catch (err: any) {
              btn.textContent = `Couldn't reset: ${err?.message ?? err}`;
            }
          },
        });
}

function statsDrawer(scope: Scope) {
  const st = regionStats(scope);
  const best = getBest(scope);
  const statRow = (label: string, value: string, sub?: string) =>
    h('div.stat', {}, h('span.muted', { textContent: label }), h('span.stat-val', {}, value, sub ? h('span.muted.small', { textContent: ` ${sub}` }) : null));
  openDrawer(
    `${scopeName(scope)} stats`,
    'Stats',
    scopeName(scope),
    h('div.drawer-hero', {}, h('div.big', { textContent: `${st.learned} / ${st.total}` }), h('div.muted.small', { textContent: 'learned' }), progressBar(st.learned, st.total)),
    h(
      'div.stat-list',
      {},
      statRow('Due now', String(st.due), st.due ? undefined : st.nextDue ? `· next ${timeUntil(st.nextDue)}` : undefined),
      statRow('Countries seen', `${st.seen} of ${st.total}`),
      statRow('Find it accuracy', pct(st.find.correct, st.find.answers), st.find.answers ? `(${st.find.answers} answers)` : undefined),
      statRow('Name it accuracy', pct(st.name.correct, st.name.answers), st.name.answers ? `(${st.name.answers} answers)` : undefined),
      statRow('Best challenge', best ? `${best.found}/${best.total}` : '–', best ? `in ${fmtTime(best.ms)}` : undefined),
      statRow('Last practiced', st.lastPlayed ? timeAgo(st.lastPlayed) : 'Not yet'),
    ),
    h('h3', { textContent: 'Most missed' }),
    st.hardest.length
      ? h(
          'ol.hardest',
          {},
          ...st.hardest.map((x) =>
            h('li', {}, h('span', { textContent: COUNTRY_BY_ID.get(x.id)!.name }), h('span.muted.small', { textContent: `${x.misses} missed of ${x.answers}` })),
          ),
        )
      : h('p.muted.small', { textContent: 'Nothing missed yet.' }),
    h('div.drawer-actions', {}, h('button.primary', { type: 'button', textContent: st.due ? `Practice ${st.due} due` : 'Practice', onclick: () => { closeDrawer(); practice(scope, 'find'); } })),
  );
}

// ---------------------------------------------------------------- Account and sync

function accountDropdown() {
  const st = syncState();
  const group = h('div.setting-group.dropdown', {});
  const toggle = <HTMLButtonElement>h(
    'button.dropdown-toggle',
    { type: 'button', ariaExpanded: 'false' },
    h('span', {}, h('span.setting-label', { textContent: 'Account and sync' }), h('span.muted.small.dropdown-sub', { textContent: st.email ?? 'not signed in' })),
    h('span.chev', { ariaHidden: 'true', textContent: '›' }),
  );
  toggle.addEventListener('click', () => {
    const open = group.classList.toggle('open');
    toggle.ariaExpanded = String(open);
  });
  group.append(toggle, h('div.dropdown-body', {}, h('div', {}, accountBox())));
  return group;
}

function accountBox() {
  const st = syncState();
  if (!st.enabled) return null;
  if (!st.email) {
    return h(
      'section.account',
      {},
      h('div', {}, h('strong', { textContent: 'Sync between devices' }), h('div.muted.small', { textContent: 'Sign in with your email to keep progress on your phone and computer.' })),
      h('button', { textContent: 'Sign in', onclick: signInScreen }),
    );
  }
  const label = {
    off: '',
    idle: 'Synced',
    syncing: 'Syncing…',
    offline: 'Offline. Will sync when you reconnect.',
    error: `Sync problem: ${st.error}`,
  }[st.status];
  return h(
    'section.account',
    {},
    h('div', {}, h('strong', { textContent: st.email }), h('div.muted.small', { textContent: label })),
    h('div.row', {}, h('button.small', { textContent: 'Sync now', onclick: () => syncNow() }), h('button.small', { textContent: 'Sign out', onclick: async () => { await signOut(); home(); } })),
  );
}

function signInScreen() {
  let creating = false;
  const msg = h('p.feedback', { role: 'status' });
  const emailInput = <HTMLInputElement>h('input', { id: 'email', type: 'email', placeholder: 'you@example.com', autocomplete: 'email', required: true });
  const pwInput = <HTMLInputElement>h('input', { id: 'password', type: 'password', autocomplete: 'current-password', required: true, minLength: 6 });
  const submit = <HTMLButtonElement>h('button.primary', { type: 'submit', textContent: 'Sign in' });
  const toggle = h('button.link', { type: 'button' });
  const intro = h('p.muted');
  function setMode(create: boolean) {
    creating = create;
    submit.textContent = create ? 'Create account' : 'Sign in';
    toggle.textContent = create ? 'I already have an account' : 'New here? Create an account';
    pwInput.autocomplete = create ? 'new-password' : 'current-password';
    pwInput.placeholder = create ? 'At least 6 characters' : '';
    intro.textContent = create
      ? 'Pick a password for your account. Progress on this device will be kept and added to it.'
      : 'Sign in to sync your progress. Progress on this device will be kept and merged with your account.';
    msg.textContent = '';
  }
  toggle.addEventListener('click', () => setMode(!creating));
  const form = h(
    'form.signin',
    {
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const email = emailInput.value.trim();
        submit.disabled = true;
        msg.textContent = creating ? 'Creating your account…' : 'Signing in…';
        try {
          if (creating) {
            const result = await signUp(email, pwInput.value);
            if (result === 'confirm-email') {
              msg.textContent = `Almost done: open the email we sent to ${email} and tap the confirm link. Then come back here and sign in.`;
              setModeKeepMsg(false);
              return;
            }
          } else {
            await signIn(email, pwInput.value);
          }
          home();
        } catch (err: any) {
          const text = String(err?.message ?? err);
          msg.textContent = /not confirmed/i.test(text)
            ? 'Please confirm your email first: tap the link in the email we sent, then sign in.'
            : /invalid login/i.test(text)
              ? 'Wrong email or password.'
              : /already registered/i.test(text)
                ? 'That email already has an account. Sign in instead.'
                : `Couldn't sign in: ${text}`;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('label', { htmlFor: 'email', textContent: 'Email' }),
    emailInput,
    h('label', { htmlFor: 'password', textContent: 'Password' }),
    pwInput,
    submit,
    toggle,
  );
  function setModeKeepMsg(create: boolean) {
    const keep = msg.textContent;
    setMode(create);
    msg.textContent = keep;
  }
  setMode(false);
  show(topBar('Sign in', home), h('main.menu', {}, intro, form, msg));
  emailInput.focus();
}

// ---------------------------------------------------------------- Region menu

function regionMenu(scope: Scope) {
  setRecent(scope);
  const n = scopeCountries(scope).length;
  const p = scope === 'world' ? null : regionProgress(scope);
  const best = getBest(scope);
  const item = (title: string, desc: string, onclick: () => void) =>
    h('button.menu-item', { onclick }, h('strong', { textContent: title }), h('span.muted.small', { textContent: desc }));
  show(
    topBar(scopeName(scope), home),
    h(
      'main.menu',
      {},
      p && h('p.muted', { textContent: `${p.learned} of ${p.total} learned · ${p.due} due for review` }),
      item('Explore', 'Tap countries to see their names and add memory hooks', () => explore(scope)),
      item('Find it', 'We name a country, you tap it on the map', () => practice(scope, 'find')),
      item('Name it', 'We highlight a country, you type its name', () => practice(scope, 'name')),
      item(
        'Timed challenge',
        `Type all ${n} names against the clock${best ? ` · best ${best.found}/${best.total} in ${fmtTime(best.ms)}` : ''}`,
        () => challenge(scope),
      ),
      h(
        'button.menu-item.arrow-item',
        { type: 'button', onclick: () => statsDrawer(scope) },
        h('span', {}, h('strong', { textContent: 'Stats' }), h('span.muted.small', { textContent: 'Accuracy, best score and your most-missed countries' })),
        h('span.arrow', { ariaHidden: 'true', textContent: '›' }),
      ),
    ),
  );
}

// ---------------------------------------------------------------- Shared bits

function mapScreen(scope: Scope, title: string, back: () => void, opts: { interactive?: Set<string>; onTap?: (id: string) => void }) {
  const map = new WorldMap({
    region: scope,
    interactive: opts.interactive ?? new Set(scopeCountries(scope).map((c) => c.id)),
    onTap: opts.onTap,
  });
  const panel = h('div.panel');
  const reset = h('button.icon', { onclick: () => map.resetZoom(), ariaLabel: 'Reset zoom', textContent: '⤢' });
  show(h('div.screen', {}, topBar(title, back, reset), map.el, panel));
  map.render();
  cleanup = () => map.destroy();
  return { map, panel };
}

function hookEditor(id: string, onDone?: () => void) {
  const c = COUNTRY_BY_ID.get(id)!;
  const ta = <HTMLTextAreaElement>h('textarea', {
    value: getNote(id),
    rows: 2,
    placeholder: `How will you remember where ${c.name} is?`,
  });
  return h(
    'div.hook-editor',
    {},
    ta,
    h('button.small', {
      textContent: 'Save hook',
      onclick: () => {
        setNote(id, ta.value);
        onDone?.();
      },
    }),
  );
}

function hookLine(id: string) {
  const note = getNote(id);
  return note ? h('p.hook', { textContent: `💡 ${note}` }) : null;
}

// ---------------------------------------------------------------- Explore

function explore(scope: Scope) {
  let selected: string | null = null;
  const { map, panel } = mapScreen(scope, `Explore ${scopeName(scope)}`, () => regionMenu(scope), {
    onTap: (id) => select(id),
  });
  const idle = () => panel.replaceChildren(h('p.prompt', { textContent: 'Tap a country. Pinch to zoom.' }));
  function select(id: string) {
    if (selected) map.mark(selected, null);
    map.clearLabels();
    selected = id;
    map.mark(id, 'target');
    const c = COUNTRY_BY_ID.get(id)!;
    map.label(id, c.name);
    panel.replaceChildren(h('p.prompt', {}, h('strong', { textContent: c.name })), hookLine(id) ?? '', hookEditor(id, () => select(id)));
  }
  idle();
}

// ---------------------------------------------------------------- Practice

function closeEnough(typed: string, target: string) {
  const a = normalizeAnswer(typed);
  const b = normalizeAnswer(target);
  if (a === b) return true;
  if (b.length < 6) return false;
  return levenshtein(a, b) <= 1 + Math.floor(b.length / 10);
}

function levenshtein(a: string, b: string) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

function practice(scope: Scope, mode: Mode) {
  const queue = pickSession(scope, mode, 10, 5);
  const firstTry = new Map<string, boolean>(); // result of the first attempt per country
  const requeued = new Set<string>();
  let idx = 0;
  let tries = 0;
  let answered = false;

  const title = mode === 'find' ? 'Find it' : 'Name it';
  const counter = () => `${Math.min(idx + 1, queue.length)} / ${queue.length}`;
  const { map, panel } = mapScreen(scope, `${title} · ${scopeName(scope)}`, () => regionMenu(scope), {
    interactive: mode === 'find' ? undefined : new Set(),
    onTap: (id) => onTap(id),
  });

  function finishQuestion(correct: boolean) {
    const id = queue[idx];
    answered = true;
    if (!firstTry.has(id)) {
      firstTry.set(id, correct);
      recordAnswer(mode, id, correct);
    }
    // Missed countries come back once at the end of the session.
    if (!correct && !requeued.has(id)) {
      requeued.add(id);
      queue.push(id);
    }
  }

  function next() {
    idx++;
    if (idx >= queue.length) return summary();
    ask();
  }

  function ask() {
    const id = queue[idx];
    const c = COUNTRY_BY_ID.get(id)!;
    tries = 0;
    answered = false;
    map.clearMarks();
    map.clearLabels();
    if (mode === 'find') {
      map.resetZoom();
      panel.replaceChildren(
        h('div.qhead', {}, h('span.muted.small', { textContent: counter() })),
        h('p.prompt', {}, 'Tap ', h('strong', { textContent: c.name })),
      );
    } else {
      map.mark(id, 'target');
      map.focus(id);
      const input = <HTMLInputElement>h('input', {
        type: 'text',
        placeholder: 'Country name',
        autocomplete: 'off',
        autocapitalize: 'words',
        spellcheck: false,
        enterKeyHint: 'done',
      });
      const form = h(
        'form.answer',
        {
          onsubmit: (e: Event) => {
            e.preventDefault();
            if (answered || !input.value.trim()) return;
            if (closeEnough(input.value, c.name) || matchAnswer(input.value) === id) correct();
            else {
              tries++;
              input.classList.add('shake');
              setTimeout(() => input.classList.remove('shake'), 400);
              const other = matchAnswer(input.value);
              feedback.textContent = other ? `No, that's not ${COUNTRY_BY_ID.get(other)!.name}.` : 'Not quite.';
              input.select();
              if (tries >= 3) reveal();
            }
          },
        },
        input,
        h('button', { type: 'submit', textContent: 'Check' }),
      );
      const feedback = h('p.feedback');
      panel.replaceChildren(
        h(
          'div.qhead',
          {},
          h('span.muted.small', { textContent: counter() }),
          h('button.link', { textContent: "I don't know", onclick: () => !answered && reveal() }),
        ),
        h('p.prompt', { textContent: 'Which country is highlighted?' }),
        form,
        feedback,
      );
      input.focus();
    }
  }

  function onTap(tapped: string) {
    if (answered || mode !== 'find') return;
    const id = queue[idx];
    if (tapped === id) return correct();
    tries++;
    map.mark(tapped, 'wrong');
    map.label(tapped, COUNTRY_BY_ID.get(tapped)!.name, 'wrong');
    const fb = panel.querySelector('.feedback') ?? panel.appendChild(h('p.feedback'));
    fb.textContent = tries >= 3 ? '' : `That's ${COUNTRY_BY_ID.get(tapped)!.name}. ${3 - tries} ${tries === 2 ? 'try' : 'tries'} left.`;
    if (tries >= 3) reveal();
  }

  function correct() {
    const id = queue[idx];
    finishQuestion(tries === 0);
    map.mark(id, 'correct');
    map.label(id, COUNTRY_BY_ID.get(id)!.name, 'correct');
    const note = hookLine(id);
    panel.replaceChildren(
      h('p.prompt.good', { textContent: tries === 0 ? `✓ ${COUNTRY_BY_ID.get(id)!.name}` : `✓ Got it on try ${tries + 1}` }),
      note ?? '',
      h('button.primary', { textContent: 'Next', onclick: next }),
    );
    if (tries === 0 && !note) setTimeout(() => idx < queue.length && queue[idx] === id && answered && next(), 900);
  }

  function reveal() {
    const id = queue[idx];
    const c = COUNTRY_BY_ID.get(id)!;
    finishQuestion(false);
    map.mark(id, 'reveal');
    map.label(id, c.name, 'reveal');
    map.focus(id);
    panel.replaceChildren(
      h('p.prompt.bad', {}, 'This is ', h('strong', { textContent: c.name }), '. It will come back at the end.'),
      hookLine(id) ?? hookEditor(id, () => reveal2()),
      h('button.primary', { textContent: 'Next', onclick: next }),
    );
    function reveal2() {
      panel.querySelector('.hook-editor')?.replaceWith(hookLine(id) ?? '');
    }
  }

  function summary() {
    cleanup?.();
    cleanup = null;
    const results = [...firstTry.entries()];
    const right = results.filter(([, ok]) => ok).length;
    const missed = results.filter(([, ok]) => !ok).map(([id]) => COUNTRY_BY_ID.get(id)!.name);
    const p = scope === 'world' ? null : regionProgress(scope, mode);
    show(
      topBar('Session done', () => regionMenu(scope)),
      h(
        'main.menu',
        {},
        h('div.big', { textContent: `${right} / ${results.length}` }),
        h('p.muted', { textContent: 'right on the first try' }),
        missed.length ? h('p', { textContent: `To review: ${missed.join(', ')}` }) : h('p', { textContent: 'Perfect session!' }),
        p && h('p.muted', { textContent: `${scopeName(scope)}: ${p.learned} of ${p.total} learned` }),
        h('button.primary', { textContent: 'Practice again', onclick: () => practice(scope, mode) }),
        h('button', { textContent: 'Back to menu', onclick: () => regionMenu(scope) }),
      ),
    );
    celebrateIfStreak(500);
  }

  if (!queue.length) {
    panel.replaceChildren(h('p.prompt', { textContent: 'Nothing to practice here.' }));
    return;
  }
  ask();
}

// ---------------------------------------------------------------- Timed challenge

function challenge(scope: Scope) {
  const list = scopeCountries(scope);
  const ids = new Set(list.map((c) => c.id));
  const total = list.length;
  const limitMs = scope === 'world' ? 15 * 60_000 : Math.max(3, Math.ceil(total / 6)) * 60_000;
  const found = new Set<string>();
  let start = 0;
  let timer = 0;
  let over = false;

  const { map, panel } = mapScreen(scope, `Challenge · ${scopeName(scope)}`, () => {
    clearInterval(timer);
    regionMenu(scope);
  }, { interactive: new Set() });
  const prevCleanup = cleanup;
  cleanup = () => {
    clearInterval(timer);
    prevCleanup?.();
  };

  const clock = h('span.clock', { textContent: fmtTime(limitMs) });
  const count = h('span.count', { textContent: `0 / ${total}` });
  const input = <HTMLInputElement>h('input', {
    type: 'text',
    placeholder: 'Type a country…',
    autocomplete: 'off',
    autocapitalize: 'words',
    spellcheck: false,
    disabled: true,
  });
  const startBtn = h('button.primary', { textContent: `Start (${fmtTime(limitMs)})`, onclick: begin });
  const giveUp = h('button.link', { textContent: 'Give up', onclick: () => end() });
  const recent = h('p.feedback');

  panel.replaceChildren(h('div.qhead', {}, count, clock, giveUp), input, recent, startBtn);
  giveUp.hidden = true;

  input.addEventListener('input', () => {
    if (over) return;
    const id = matchAnswer(input.value);
    if (id && ids.has(id) && !found.has(id)) {
      found.add(id);
      map.mark(id, 'correct');
      input.value = '';
      count.textContent = `${found.size} / ${total}`;
      recent.textContent = `✓ ${COUNTRY_BY_ID.get(id)!.name}`;
      if (found.size === total) end();
    }
  });

  function begin() {
    startBtn.remove();
    giveUp.hidden = false;
    input.disabled = false;
    input.focus();
    start = Date.now();
    timer = window.setInterval(() => {
      const left = limitMs - (Date.now() - start);
      clock.textContent = fmtTime(left);
      if (left <= 0) end();
    }, 250);
  }

  function end() {
    if (over) return;
    over = true;
    clearInterval(timer);
    const ms = Math.min(Date.now() - start, limitMs);
    input.disabled = true;
    const missed = list.filter((c) => !found.has(c.id));
    for (const c of missed) map.mark(c.id, 'reveal');
    const isBest = found.size > 0 && submitScore(scope, { found: found.size, total, ms, at: Date.now() });
    if (found.size) {
      markActive();
      celebrateIfStreak(900);
    }
    // Let the missed ones be tapped to see their names.
    map.el.addEventListener('click', (ev) => {
      const id = (ev.target as SVGElement).dataset?.id;
      if (id && ids.has(id)) {
        map.clearLabels();
        map.label(id, COUNTRY_BY_ID.get(id)!.name, found.has(id) ? 'correct' : 'reveal');
      }
    });
    panel.replaceChildren(
      h('p.prompt', {}, h('strong', { textContent: `${found.size} / ${total}` }), ` in ${fmtTime(ms)}${isBest ? ' · new best!' : ''}`),
      missed.length
        ? h('p.small', { textContent: `Missed (red, tap to see names): ${shuffle(missed).slice(0, 12).map((c) => c.name).join(', ')}${missed.length > 12 ? '…' : ''}` })
        : h('p.good', { textContent: 'You got them all!' }),
      h('div.row', {}, h('button.primary', { textContent: 'Try again', onclick: () => challenge(scope) }), h('button', { textContent: 'Menu', onclick: () => regionMenu(scope) })),
    );
  }
}

onSyncState(() => {
  // Refresh the account box in the side menu, if it's open.
  const box = document.querySelector('.account');
  const next = accountBox();
  if (box && next) box.replaceWith(next);
});
home();
initSync(() => {
  if (onHome) home();
});
