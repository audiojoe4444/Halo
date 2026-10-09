// Halo data layer.
//
// Everything above this file speaks one language: Philips Hue "CLIP v2" resources
// (room, zone, scene, grouped_light, bridge_home). Three interchangeable backends
// carry those calls:
//
//   relay  - your own tiny Cloudflare Worker that talks to the Hue cloud for you.
//            This is the one that works from GitHub Pages on the glasses.
//   local  - straight to the bridge (https://<bridge-ip>/clip/v2). Advanced: browsers
//            do not trust the bridge's certificate, so this mostly suits desktop tests.
//   demo   - a pretend house in memory, so the UI can be tried with no Hue at all.

export class HueError extends Error {
  // kind: 'config' | 'network' | 'auth' | 'unlinked' | 'server'
  constructor(kind, message, status = 0) {
    super(message);
    this.name = 'HueError';
    this.kind = kind;
    this.status = status;
  }
}

/** "Copper Lantern, river!" -> "copper-lantern-river". Same rule as the relay, so
 *  dictation / handwriting quirks (spaces, capitals, commas) never break the PIN. */
export function normalisePin(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const cleanBase = (u) => String(u ?? '').trim().replace(/\/+$/, '');

async function http(base, headers, method, path, body, timeoutMs = 9000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
      cache: 'no-store',
    });
    const raw = await res.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }

    if (json && (json.error === 'not_linked' || json.error === 'hue_auth')) {
      throw new HueError('unlinked', 'The relay is not linked to Hue yet', res.status);
    }
    if (res.status === 401 || res.status === 403) {
      throw new HueError('auth', 'That PIN or key was not accepted', res.status);
    }
    if (!res.ok) throw new HueError('server', `Hue answered ${res.status}`, res.status);
    if (json && Array.isArray(json.errors) && json.errors.length) {
      throw new HueError('server', json.errors[0].description || 'Hue refused that', res.status);
    }
    return json;
  } catch (e) {
    if (e instanceof HueError) throw e;
    throw new HueError('network', e && e.name === 'AbortError' ? 'Timed out reaching Hue' : 'Can’t reach Hue', 0);
  } finally {
    clearTimeout(timer);
  }
}

function relayBackend({ relayUrl, pin }) {
  const base = cleanBase(relayUrl);
  if (!/^https:\/\/[^/]+/i.test(base)) throw new HueError('config', 'Relay address must start with https://');
  const p = normalisePin(pin);
  if (!p) throw new HueError('config', 'Enter your PIN phrase');
  const headers = { Authorization: `Bearer ${p}` };
  const clip = `${base}/clip/v2`;
  return {
    mode: 'relay',
    get: (path) => http(clip, headers, 'GET', path),
    put: (path, body) => http(clip, headers, 'PUT', path, body),
    async status() {
      const j = await http(base, headers, 'GET', '/status');
      // The relay answers 200 even when it has never been linked to Hue; say so.
      if (j && j.linked === false) throw new HueError('unlinked', 'The relay is not linked to Hue yet', 200);
      return j;
    },
  };
}

function localBackend({ bridgeIp, appKey }) {
  const host = String(bridgeIp ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host) throw new HueError('config', 'Enter the bridge address');
  const key = String(appKey ?? '').trim();
  if (!key) throw new HueError('config', 'Enter the bridge app key');
  const clip = `https://${host}/clip/v2`;
  const headers = { 'hue-application-key': key };
  return {
    mode: 'local',
    get: (path) => http(clip, headers, 'GET', path),
    put: (path, body) => http(clip, headers, 'PUT', path, body),
    status: () => http(clip, headers, 'GET', '/resource/bridge_home'),
  };
}

// ---------------------------------------------------------------------------
// Demo backend: a small make-believe house that behaves like a bridge.
// ---------------------------------------------------------------------------
function demoBackend() {
  let n = 0;
  const uid = () => `11111111-1111-4111-8111-${String(++n).padStart(12, '0')}`;
  const db = { room: [], zone: [], grouped_light: [], scene: [], bridge_home: [] };

  const SCENES = [
    ['Bright', 100], ['Relax', 55], ['Concentrate', 90], ['Nightlight', 8], ['Energize', 100],
  ];
  const addGroup = (type, name, archetype, scenes, on, brightness) => {
    const gl = { id: uid(), type: 'grouped_light', on: { on }, dimming: { brightness } };
    const grp = {
      id: uid(), type, metadata: { name, archetype },
      services: [{ rid: gl.id, rtype: 'grouped_light' }],
    };
    gl.owner = { rid: grp.id, rtype: type };
    db.grouped_light.push(gl);
    db[type].push(grp);
    scenes.forEach((idx) => {
      const [sname, level] = SCENES[idx];
      db.scene.push({
        id: uid(), type: 'scene', metadata: { name: sname },
        group: { rid: grp.id, rtype: type }, status: { active: 'inactive' }, _level: level,
      });
    });
  };
  addGroup('room', 'Living Room', 'living_room', [0, 1, 2, 3], true, 62);
  addGroup('room', 'Kitchen', 'kitchen', [0, 2, 4], false, 100);
  addGroup('room', 'Bedroom', 'bedroom', [1, 3], false, 40);
  addGroup('room', 'Hallway', 'hallway', [0, 3], true, 30);
  addGroup('room', 'Office', 'office', [0, 2, 4], false, 90);
  addGroup('zone', 'Downstairs', 'downstairs', [], true, 55);
  addGroup('zone', 'Upstairs', 'upstairs', [], false, 40);

  const home = { id: uid(), type: 'bridge_home', services: [] };
  const allGl = { id: uid(), type: 'grouped_light', on: { on: true }, dimming: { brightness: 60 }, owner: { rid: home.id, rtype: 'bridge_home' } };
  home.services.push({ rid: allGl.id, rtype: 'grouped_light' });
  db.grouped_light.push(allGl);
  db.bridge_home.push(home);

  const syncAll = () => {
    const others = db.grouped_light.filter((g) => g.id !== allGl.id && g.owner.rtype === 'room');
    allGl.on.on = others.some((g) => g.on.on);
    const lit = others.filter((g) => g.on.on);
    if (lit.length) allGl.dimming.brightness = Math.round(lit.reduce((a, g) => a + g.dimming.brightness, 0) / lit.length);
  };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, v) => (k.startsWith('_') ? undefined : v)));

  return {
    mode: 'demo',
    async get(path) {
      await delay(120);
      const m = /^\/resource\/([a-z_]+)$/.exec(path);
      if (!m || !db[m[1]]) throw new HueError('server', 'Not found', 404);
      return { errors: [], data: strip(db[m[1]]) };
    },
    async put(path, body) {
      await delay(120);
      const m = /^\/resource\/(grouped_light|scene)\/([0-9a-f-]{36})$/.exec(path);
      if (!m) throw new HueError('server', 'Not found', 404);
      const [, type, id] = m;
      const item = db[type].find((x) => x.id === id);
      if (!item) throw new HueError('server', 'Not found', 404);
      if (type === 'grouped_light') {
        const targets = item.id === allGl.id ? db.grouped_light : [item];
        targets.forEach((g) => {
          if (body.on) g.on.on = !!body.on.on;
          if (body.dimming) g.dimming.brightness = body.dimming.brightness;
        });
      } else {
        const gl = db.grouped_light.find((g) => g.owner.rid === item.group.rid);
        gl.on.on = true;
        gl.dimming.brightness = item._level;
        db.scene.filter((s) => s.group.rid === item.group.rid).forEach((s) => { s.status.active = s.id === item.id ? 'static' : 'inactive'; });
      }
      syncAll();
      return { errors: [], data: [{ rid: id, rtype: type }] };
    },
    async status() { return { ok: true, demo: true }; },
  };
}

export function makeBackend(cfg) {
  switch (cfg.mode) {
    case 'relay': return relayBackend(cfg);
    case 'local': return localBackend(cfg);
    case 'demo': return demoBackend();
    default: throw new HueError('config', 'Choose how Halo should connect');
  }
}

// ---------------------------------------------------------------------------
// The API the UI uses.
// ---------------------------------------------------------------------------
export class HueApi {
  constructor(backend) { this.b = backend; }
  get mode() { return this.b.mode; }

  async loadHome() {
    const types = ['room', 'zone', 'grouped_light', 'scene', 'bridge_home'];
    const [rooms, zones, groups, scenes, homes] = await Promise.all(types.map((t) => this.b.get(`/resource/${t}`)));
    const rows = (x) => (x && Array.isArray(x.data) ? x.data : []);

    const glById = new Map(rows(groups).map((g) => [g.id, g]));
    const mapGroup = (r, kind) => {
      const svc = (r.services || []).find((s) => s.rtype === 'grouped_light');
      const g = svc && glById.get(svc.rid);
      if (!g) return null;
      return {
        id: r.id,
        kind,
        name: (r.metadata && r.metadata.name) || 'Unnamed',
        groupedId: g.id,
        on: !!(g.on && g.on.on),
        brightness: g.dimming && typeof g.dimming.brightness === 'number' ? Math.round(g.dimming.brightness) : null,
        scenes: [],
      };
    };
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const roomList = rows(rooms).map((r) => mapGroup(r, 'room')).filter(Boolean).sort(byName);
    const zoneList = rows(zones).map((r) => mapGroup(r, 'zone')).filter(Boolean).sort(byName);

    const byId = new Map([...roomList, ...zoneList].map((g) => [g.id, g]));
    rows(scenes).forEach((sc) => {
      const target = sc.group && byId.get(sc.group.rid);
      if (!target) return;
      target.scenes.push({
        id: sc.id,
        name: (sc.metadata && sc.metadata.name) || 'Scene',
        active: !!(sc.status && sc.status.active && sc.status.active !== 'inactive'),
      });
    });
    [...roomList, ...zoneList].forEach((g) => g.scenes.sort(byName));

    let all = null;
    const home = rows(homes)[0];
    const homeSvc = home && (home.services || []).find((s) => s.rtype === 'grouped_light');
    const homeGl = homeSvc && glById.get(homeSvc.rid);
    if (homeGl) {
      all = {
        id: 'all', kind: 'all', name: 'All lights', groupedId: homeGl.id,
        on: !!(homeGl.on && homeGl.on.on),
        brightness: homeGl.dimming && typeof homeGl.dimming.brightness === 'number' ? Math.round(homeGl.dimming.brightness) : null,
        scenes: [],
      };
    }
    return { all, rooms: roomList, zones: zoneList, at: Date.now() };
  }

  setOn(groupedId, on) {
    return this.b.put(`/resource/grouped_light/${groupedId}`, { on: { on: !!on } });
  }
  setBrightness(groupedId, pct) {
    return this.b.put(`/resource/grouped_light/${groupedId}`, {
      on: { on: true },
      dimming: { brightness: clamp(Math.round(pct), 1, 100) },
    });
  }
  recallScene(sceneId) {
    return this.b.put(`/resource/scene/${sceneId}`, { recall: { action: 'active' } });
  }
  status() { return this.b.status(); }
}
