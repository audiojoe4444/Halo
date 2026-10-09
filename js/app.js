// Halo - Philips Hue on Meta Ray-Ban Display.
//
// Built the way Meta's web app docs ask:
//  * Native <button>/<input> controls; the glasses' browser does the directional
//    (spatial) navigation and Enter-to-activate. No global focus manager here.
//  * Back is the system Back = history.back(). Each screen is a history entry
//    (kept shallow: the host allows 5 entries total).
//  * Text fields are type=text/url so the system composer (handwriting, dictation,
//    on-screen keyboard) opens. (password/date/radio/checkbox inputs do not.)
//  * The only key handling is the brightness slider, which uses Left/Right and
//    leaves Up/Down alone so vertical navigation still works.

import { makeBackend, HueApi, HueError } from './hue.js';

const CFG = window.HALO_CONFIG || {};
const STORE_KEY = 'halo.v1.settings';
const EMPTY = { mode: null, relayUrl: '', pin: '', bridgeIp: '', appKey: '' };
const STEP = 5; // brightness % per Left/Right press

const $title = document.getElementById('title');
const $meta = document.getElementById('meta');
const $main = document.getElementById('main');
const $toast = document.getElementById('toast');

// ---------------------------------------------------------------- settings
const mem = { settings: null };
function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...EMPTY, ...JSON.parse(raw) };
  } catch { /* storage can be missing or cleared - fall through */ }
  return { ...EMPTY, ...(mem.settings || {}) };
}
function saveSettings(s) {
  mem.settings = s;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); return true; } catch { return false; }
}
function clearSettings() {
  mem.settings = null;
  try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ }
}

/** ?relay=...&pin=... (or ?bridge=...&key=...) pre-fills settings, then is removed from the URL. */
function ingestUrlParams() {
  const p = new URLSearchParams(location.search);
  const known = ['relay', 'pin', 'bridge', 'key', 'mode'];
  if (![...p.keys()].some((k) => known.includes(k))) return;
  const s = loadSettings();
  if (p.get('relay')) s.relayUrl = p.get('relay');
  if (p.get('pin')) s.pin = p.get('pin');
  if (p.get('bridge')) s.bridgeIp = p.get('bridge');
  if (p.get('key')) s.appKey = p.get('key');
  const m = p.get('mode');
  if (m === 'demo' || m === 'relay' || m === 'local') s.mode = m;
  else if (p.get('relay') || p.get('pin')) s.mode = 'relay';
  else if (p.get('bridge')) s.mode = 'local';
  saveSettings(s);
  history.replaceState(history.state, '', location.pathname + location.hash);
}

// ------------------------------------------------------------------- state
const S = {
  settings: EMPTY,
  api: null,
  home: null,
  error: null,
  loading: false,
  lastInteraction: 0,
  restoreKey: null,
  timers: new Map(),
  poll: null,
  offlineToasted: false,
};

// ------------------------------------------------------------------ helpers
function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
}

const ICONS = {
  power: '<path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  chevron: '<path d="M9 5l7 7-7 7"/>',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ico');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

let toastTimer = 0;
function toast(msg, ms = 3200) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, ms);
}

const markInteraction = () => { S.lastInteraction = Date.now(); };
const stateText = (g) => (g.on ? (g.brightness !== null ? `On · ${g.brightness}%` : 'On') : 'Off');
const findGroup = (id) => (S.home ? [...S.home.rooms, ...S.home.zones].find((g) => g.id === id) : null);

function updateScrollCue() {
  const more = $main.scrollHeight - $main.clientHeight - $main.scrollTop > 10;
  $main.classList.toggle('more-below', more);
}
$main.addEventListener('scroll', updateScrollCue, { passive: true });

// --------------------------------------------------------------- navigation
// History entries: {v:'home'} -> {v:'room', id} / {v:'settings', from:'home'}
const HOME = { v: 'home' };
history.replaceState(HOME, '');

function navigate(state) {
  history.pushState(state, '');
  render({ initial: true });
}
window.addEventListener('popstate', () => {
  render({ initial: true });
  if (S.api && (!S.home || Date.now() - S.home.at > 5000)) refresh(true);
});

function openRoom(id) {
  S.restoreKey = `open:${id}`;
  markInteraction();
  navigate({ v: 'room', id });
}
function openSettings() {
  S.restoreKey = 'settings';
  navigate({ v: 'settings', from: 'home' });
}
function leaveSettings() {
  if (history.state && history.state.from === 'home') history.back();
  else { history.replaceState(HOME, ''); render({ initial: true }); }
}

// ------------------------------------------------------------- connecting
function buildApi() {
  S.api = null;
  S.error = null;
  const s = S.settings;
  if (!s.mode) return false;
  try {
    S.api = new HueApi(makeBackend({ ...s, relayUrl: s.relayUrl || CFG.relayUrl || '' }));
    return true;
  } catch (e) {
    S.error = e instanceof HueError ? e : new HueError('config', String(e && e.message || e));
    return false;
  }
}

function connect() {
  S.home = null;
  buildApi();
  stopPolling();
  if (S.api) { startPolling(); refresh(false); } else render({ initial: true });
}

async function refresh(silent) {
  if (!S.api || S.loading) return;
  S.loading = true;
  if (!silent && !S.home) render({ initial: true });
  try {
    S.home = await S.api.loadHome();
    S.error = null;
    S.offlineToasted = false;
  } catch (e) {
    const err = e instanceof HueError ? e : new HueError('network', 'Can’t reach Hue');
    if (S.home && err.kind === 'network') {
      if (!S.offlineToasted) { toast('Connection lost – retrying'); S.offlineToasted = true; }
    } else {
      S.error = err;
      S.home = null;
    }
  } finally {
    S.loading = false;
  }
  // A visible (first) load is a fresh screen: put focus on its first control.
  // A silent refresh must leave focus and scroll exactly where the wearer has them.
  render(silent ? { keepFocus: true } : { initial: true });
}

function startPolling() {
  const ms = Math.max(5, Number(CFG.pollSeconds) || 12) * 1000;
  S.poll = setInterval(() => {
    if (document.hidden || !S.api || S.settings.mode === 'demo') return;
    const v = history.state && history.state.v;
    if (v === 'settings') return;
    if (Date.now() - S.lastInteraction < 2500) return; // don't fight the wearer's own input
    refresh(true);
  }, ms);
}
function stopPolling() { clearInterval(S.poll); S.poll = null; }
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.api) refresh(true); });

// ------------------------------------------------------------------ commands
function handleCommandError(e) {
  const err = e instanceof HueError ? e : new HueError('network', 'Can’t reach Hue');
  if (err.kind === 'auth' || err.kind === 'unlinked' || err.kind === 'config') {
    S.error = err; S.home = null; render({ initial: true });
  } else {
    toast(err.message);
    setTimeout(() => refresh(true), 800);
  }
}

async function toggle(g) {
  markInteraction();
  const next = !g.on;
  g.on = next;
  render({ keepFocus: true });
  try {
    await S.api.setOn(g.groupedId, next);
    setTimeout(() => { if (Date.now() - S.lastInteraction > 1500) refresh(true); }, 1600);
  } catch (e) { g.on = !next; render({ keepFocus: true }); handleCommandError(e); }
}

function queueBrightness(g) {
  clearTimeout(S.timers.get(g.groupedId));
  S.timers.set(g.groupedId, setTimeout(async () => {
    try { await S.api.setBrightness(g.groupedId, g.brightness); }
    catch (e) { handleCommandError(e); }
  }, 280));
}

async function recall(g, scene) {
  markInteraction();
  g.scenes.forEach((s) => { s.active = s.id === scene.id; });
  g.on = true;
  render({ keepFocus: true });
  try {
    await S.api.recallScene(scene.id);
    setTimeout(() => refresh(true), 1000); // pick up the brightness the scene actually set
  } catch (e) { handleCommandError(e); }
}

// --------------------------------------------------------------------- views
function eyebrow(text) { return el('div', { class: 'eyebrow', text }); }

function powerButton(g, key) {
  return el('button', {
    class: 'btn pwr', type: 'button',
    'aria-label': `${g.name} power`, 'aria-pressed': String(g.on),
    dataset: { key, on: String(g.on) },
    onclick: () => toggle(g),
  }, icon('power'));
}

function roomRow(g) {
  return el('div', { class: 'row' },
    el('button', {
      class: 'btn', type: 'button', dataset: { key: `open:${g.id}`, on: String(g.on) },
      onclick: () => openRoom(g.id),
    },
    el('span', { class: 'dot' }),
    el('span', { class: 'grow' }, el('span', { class: 'name', text: g.name }), el('span', { class: 'sub', text: stateText(g) })),
    icon('chevron')),
    powerButton(g, `pwr:${g.id}`));
}

function homeView() {
  const h = S.home;
  $title.textContent = 'Halo';
  $meta.textContent = S.settings.mode === 'demo' ? 'Demo' : `${h.rooms.length} room${h.rooms.length === 1 ? '' : 's'}`;
  const out = [];

  if (h.all) {
    out.push(el('div', { class: 'row' },
      el('button', {
        class: 'btn', type: 'button', dataset: { key: 'all', on: String(h.all.on) },
        'aria-pressed': String(h.all.on), onclick: () => toggle(h.all),
      },
      el('span', { class: 'dot' }),
      el('span', { class: 'grow' }, el('span', { class: 'name', text: 'All lights' }), el('span', { class: 'sub', text: stateText(h.all) }))),
      powerButton(h.all, 'pwr:all')));
  }
  if (h.rooms.length) {
    out.push(eyebrow('Rooms'));
    h.rooms.forEach((g, i) => { const r = roomRow(g); if (i === 0) r.firstChild.setAttribute('data-autofocus', ''); out.push(r); });
  }
  if (h.zones.length) {
    out.push(eyebrow('Zones'));
    h.zones.forEach((g) => out.push(roomRow(g)));
  }
  if (!h.rooms.length && !h.zones.length) out.push(el('p', { class: 'note', text: 'No rooms were found on this Hue system.' }));

  out.push(eyebrow('Halo'));
  out.push(el('div', { class: 'row single' },
    el('button', { class: 'btn ghost', type: 'button', dataset: { key: 'settings' }, onclick: openSettings },
      icon('sliders'), el('span', { class: 'grow', text: 'Settings' }))));
  return out;
}

function slider(g) {
  const fill = el('div', { class: 'fill' });
  const val = el('span', { class: 'val', text: `${g.brightness}%` });
  const set = (v) => {
    fill.parentNode.parentNode.setAttribute('aria-valuenow', String(v));
    val.textContent = `${v}%`;
    fill.style.setProperty('--pct', `${v}%`);
  };
  const node = el('div', {
    class: 'slider', role: 'slider', tabindex: '0',
    'aria-label': `${g.name} brightness`, 'aria-valuemin': '1', 'aria-valuemax': '100', 'aria-valuenow': String(g.brightness),
    dataset: { key: 'slider' },
    onkeydown: (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; // Up/Down keep moving focus
      e.preventDefault();
      markInteraction();
      const next = Math.min(100, Math.max(1, (g.brightness ?? 50) + (e.key === 'ArrowRight' ? STEP : -STEP)));
      if (next === g.brightness && g.on) return;
      const wasOff = !g.on;
      g.brightness = next;
      g.on = true;
      set(next);
      $meta.textContent = stateText(g);
      if (wasOff) render({ keepFocus: true }); // power button flips to "Turn off"
      queueBrightness(g);
    },
  },
  el('div', { class: 'top' }, el('span', { text: 'Brightness' }), val),
  el('div', { class: 'track' }, fill),
  el('span', { class: 'hint', text: '◀ ▶ to adjust' }));
  fill.style.setProperty('--pct', `${g.brightness}%`);
  return node;
}

function roomView(g) {
  $title.textContent = g.name;
  $meta.textContent = stateText(g);
  const out = [];
  out.push(el('button', {
    class: 'btn big', type: 'button', dataset: { key: 'power', on: String(g.on) }, 'data-autofocus': '',
    'aria-pressed': String(g.on), onclick: () => toggle(g),
  }, icon('power'), el('span', { text: g.on ? 'Turn off' : 'Turn on' })));
  if (g.brightness !== null) out.push(slider(g));
  out.push(eyebrow('Scenes'));
  if (!g.scenes.length) out.push(el('p', { class: 'note', text: 'No scenes in this room yet. Create some in the Hue app.' }));
  g.scenes.forEach((sc) => {
    out.push(el('button', {
      class: 'btn scene', type: 'button', dataset: { key: `scene:${sc.id}`, on: String(sc.active) },
      style: 'margin-block-end:10px', onclick: () => recall(g, sc),
    },
    el('span', { class: 'grow' }, el('span', { class: 'name', text: sc.name })),
    sc.active ? icon('check') : null));
  });
  return out;
}

function centered(title, body, buttons = [], busy = false) {
  return [el('div', { class: 'center' },
    busy ? el('div', { class: 'pulse', 'aria-hidden': 'true' }) : null,
    el('h2', { text: title }),
    body ? el('p', { text: body }) : null,
    ...buttons)];
}

function loadingView() {
  $title.textContent = 'Halo';
  $meta.textContent = '';
  return centered('Connecting…', 'Asking your lights how they are.', [], true);
}

function errorView() {
  const e = S.error;
  $title.textContent = 'Halo';
  $meta.textContent = '';
  const retry = el('button', { class: 'btn primary', type: 'button', 'data-autofocus': '', dataset: { key: 'retry' }, onclick: () => connect() }, 'Try again');
  const settings = el('button', { class: 'btn ghost', type: 'button', dataset: { key: 'settings' }, onclick: openSettings }, 'Settings');
  const relay = (S.settings.relayUrl || CFG.relayUrl || '').replace(/\/+$/, '');
  if (e.kind === 'auth') return centered('PIN not accepted', 'Check the PIN phrase in Settings.', [settings, retry]);
  if (e.kind === 'unlinked') {
    return centered('Link Hue first', relay ? `On your phone, open ${relay}/auth/start and sign in to Hue.` : 'Your relay is not linked to Hue yet.', [retry, settings]);
  }
  if (e.kind === 'config') return centered('Almost there', e.message, [settings]);
  const detail = e.kind === 'network' && S.settings.mode === 'relay'
    ? 'Halo couldn’t reach your relay. Check the glasses’ connection and the relay address.'
    : e.message;
  return centered('Can’t reach your lights', detail, [retry, settings]);
}

function setupView() {
  $title.textContent = 'Halo';
  $meta.textContent = '';
  const choose = (mode, go) => () => {
    S.settings = { ...S.settings, mode };
    saveSettings(S.settings);
    if (go === 'settings') { history.replaceState({ v: 'settings', from: null }, ''); render({ initial: true }); } else connect();
  };
  return centered('Halo', 'Philips Hue lights, on your glasses.', [
    el('button', { class: 'btn primary', type: 'button', 'data-autofocus': '', dataset: { key: 'setup-relay' }, onclick: choose('relay', 'settings') }, 'Connect my lights'),
    el('button', { class: 'btn ghost', type: 'button', dataset: { key: 'setup-demo' }, onclick: choose('demo') }, 'Try the demo'),
  ]);
}

function settingsView() {
  $title.textContent = 'Settings';
  $meta.textContent = '';
  const D = settingsView.draft || (settingsView.draft = { ...S.settings, relayUrl: S.settings.relayUrl || CFG.relayUrl || '' });
  let statusLine = settingsView.statusLine;
  if (!statusLine) { statusLine = el('p', { class: 'note', role: 'status', text: '' }); settingsView.statusLine = statusLine; }

  const modes = [['relay', 'Relay (recommended)'], ['local', 'Local bridge (advanced)'], ['demo', 'Demo – no lights']];
  const out = [eyebrow('Connection')];
  modes.forEach(([m, label]) => {
    out.push(el('button', {
      class: 'btn', type: 'button', role: 'radio', 'aria-checked': String(D.mode === m),
      dataset: { key: `mode:${m}`, on: String(D.mode === m) }, style: 'margin-block-end:10px',
      onclick: () => { D.mode = m; render({ keepFocus: true }); },
    }, el('span', { class: 'dot' }), el('span', { class: 'grow', text: label })));
  });

  const field = (key, label, prop, props = {}) => el('label', { class: 'field' },
    el('span', { text: label }),
    el('input', { type: 'text', value: D[prop] || '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', dataset: { key }, ...props,
      oninput: (e) => { D[prop] = e.target.value; }, onchange: (e) => { D[prop] = e.target.value; } }));

  if (D.mode === 'relay') {
    out.push(eyebrow('Relay'));
    out.push(field('f-relay', 'Relay address', 'relayUrl', { type: 'url', placeholder: 'https://halo-relay.you.workers.dev' }));
    out.push(field('f-pin', 'PIN phrase (e.g. three or four words)', 'pin', { placeholder: 'copper lantern river' }));
  } else if (D.mode === 'local') {
    out.push(eyebrow('Local bridge'));
    out.push(field('f-ip', 'Bridge address', 'bridgeIp', { placeholder: '192.168.1.20' }));
    out.push(field('f-key', 'Bridge app key', 'appKey', { placeholder: 'long key from your bridge' }));
  }
  out.push(statusLine);

  if (D.mode && D.mode !== 'demo') {
    out.push(el('button', {
      class: 'btn ghost', type: 'button', dataset: { key: 'test' }, style: 'margin-block-end:10px',
      onclick: async () => {
        statusLine.className = 'note'; statusLine.textContent = 'Testing…';
        try {
          const api = new HueApi(makeBackend({ ...D }));
          await api.status();
          statusLine.textContent = 'Connected.';
        } catch (e) {
          statusLine.className = 'note err';
          statusLine.textContent = e.kind === 'unlinked' ? 'Relay works, but is not linked to Hue yet.' : (e.message || 'Could not connect.');
        }
      },
    }, 'Test connection'));
  }
  out.push(el('button', {
    class: 'btn primary', type: 'button', dataset: { key: 'save' }, style: 'margin-block-end:10px',
    onclick: () => {
      if (!D.mode) { statusLine.className = 'note err'; statusLine.textContent = 'Choose a connection first.'; return; }
      S.settings = { ...D };
      const ok = saveSettings(S.settings);
      settingsView.draft = null; settingsView.statusLine = null;
      if (!ok) toast('Saved for now, but this device would not keep it');
      connect();
      leaveSettings();
    },
  }, 'Save and connect'));
  out.push(el('button', {
    class: 'btn ghost', type: 'button', dataset: { key: 'forget' },
    onclick: () => {
      clearSettings(); S.settings = { ...EMPTY }; settingsView.draft = null; settingsView.statusLine = null;
      stopPolling(); S.api = null; S.home = null; S.error = null;
      history.replaceState(HOME, ''); render({ initial: true });
    },
  }, 'Forget settings'));
  return out;
}

// -------------------------------------------------------------------- render
function render(opts = {}) {
  const st = history.state || HOME;
  const keepKey = opts.keepFocus && document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : null;
  const scroll = opts.keepFocus ? $main.scrollTop : 0;
  if (st.v !== 'settings') { settingsView.draft = null; settingsView.statusLine = null; }

  let nodes;
  if (st.v === 'settings') nodes = settingsView();
  else if (!S.settings.mode) nodes = setupView();
  else if (S.error && !S.home) nodes = errorView();
  else if (!S.home) nodes = loadingView();
  else if (st.v === 'room') {
    const g = findGroup(st.id);
    if (g) nodes = roomView(g);
    else { history.replaceState(HOME, ''); nodes = homeView(); }
  } else nodes = homeView();

  $main.replaceChildren(...nodes);
  $main.scrollTop = scroll;

  const pick = (k) => k && $main.querySelector(`[data-key="${k.replace(/"/g, '\\"')}"]`);
  let target = pick(keepKey);
  // Coming back to the list: put focus on the row/button the wearer left from.
  const leaf = st.v === 'room' || st.v === 'settings';
  if (!target && opts.initial && S.restoreKey && !leaf) target = pick(S.restoreKey);
  if (opts.initial && !leaf && S.home) S.restoreKey = null;
  if (!target && (opts.initial || opts.keepFocus)) target = $main.querySelector('[data-autofocus]') || $main.querySelector('button, input, [tabindex="0"]');
  if (target && (opts.initial || keepKey)) target.focus({ preventScroll: !opts.initial });
  updateScrollCue();
}

// ---------------------------------------------------------------------- boot
ingestUrlParams();
S.settings = loadSettings();
if (S.settings.mode) connect(); else render({ initial: true });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* works fine online without it */ });
}
