import './style.css';
import { COUNTRIES, COUNTRY_BY_ID, matchAnswer, normalizeAnswer, REGIONS, regionCountries, type RegionId } from './countries';
import { WorldMap } from './map';
import {
  getBest, getNote, pickSession, recordAnswer, regionProgress, setNote, shuffle, submitScore, totalLearned,
  type Mode,
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

function topBar(title: string, back?: () => void, right?: Node) {
  return h(
    'header.bar',
    {},
    back ? h('button.icon', { onclick: back, ariaLabel: 'Back', textContent: '‹' }) : h('span.icon-spacer'),
    h('h1', { textContent: title }),
    right ?? h('span.icon-spacer'),
  );
}

function progressBar(value: number, total: number) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return h('div.progress', { role: 'progressbar', ariaValueNow: String(pct) }, h('div', { style: `width:${pct}%` }));
}

function fmtTime(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Home

function home() {
  const learned = totalLearned();
  const worldBest = getBest('world');
  show(
    topBar('Country Quiz'),
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
      h('p.tip', {
        textContent: 'Learn one region at a time: explore the map, practise until it sticks, then try the timed challenge. Come back every couple of days for reviews.',
      }),
      h(
        'div.regions',
        {},
        ...REGIONS.map((r) => {
          const p = regionProgress(r.id);
          const best = getBest(r.id);
          return h(
            'button.region-card',
            { onclick: () => regionMenu(r.id) },
            h('div.row', {}, h('strong', { textContent: r.name }), p.due ? h('span.badge', { textContent: `${p.due} due` }) : null),
            h('div.muted.small', { textContent: `${p.learned} of ${p.total} learned${best ? ` · best ${best.found}/${best.total}` : ''}` }),
            progressBar(p.learned, p.total),
          );
        }),
        h(
          'button.region-card.world',
          { onclick: () => regionMenu('world') },
          h('strong', { textContent: 'Whole world' }),
          h('div.muted.small', {
            textContent: worldBest ? `Best: ${worldBest.found}/${worldBest.total} in ${fmtTime(worldBest.ms)}` : 'Timed quiz on all 197 countries',
          }),
        ),
      ),
      accountBox(),
      h(
        'footer.foot',
        {},
        h('button.link', {
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
              onSyncState(() => {
  // Refresh just the account box so the page doesn't jump while syncing.
  const box = document.querySelector('.account');
  const next = onHome ? accountBox() : null;
  if (box && next) box.replaceWith(next);
  else if (onHome && !!box !== !!next) home();
});
home();
initSync(() => {
  if (onHome) home();
});
            } catch (err: any) {
              btn.textContent = `Couldn't reset: ${err?.message ?? err}`;
            }
          },
        }),
      ),
    ),
  );
  onHome = true;
}

// ---------------------------------------------------------------- Account and sync

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
        h('button.primary', { textContent: 'Practise again', onclick: () => practice(scope, mode) }),
        h('button', { textContent: 'Back to menu', onclick: () => regionMenu(scope) }),
      ),
    );
  }

  if (!queue.length) {
    panel.replaceChildren(h('p.prompt', { textContent: 'Nothing to practise here.' }));
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
  // Refresh just the account box so the page doesn't jump while syncing.
  const box = document.querySelector('.account');
  const next = onHome ? accountBox() : null;
  if (box && next) box.replaceWith(next);
  else if (onHome && !!box !== !!next) home();
});
home();
initSync(() => {
  if (onHome) home();
});
