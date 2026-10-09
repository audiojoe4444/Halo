// Halo relay - a tiny Cloudflare Worker (free plan is plenty).
//
// Why it exists: GitHub Pages is https, and a page on https is not allowed to talk
// to a Hue bridge on your home network (the bridge only speaks http/https with a
// certificate browsers don't trust). The Philips Hue *cloud* ("Remote API") is
// reachable from anywhere, but signing in to it needs a secret that must never
// sit in a web page. So this Worker holds the secret, signs in once, keeps the
// tokens refreshed, and passes Halo's light commands through.
//
// Settings (Worker > Settings > Variables and Secrets):
//   HUE_CLIENT_ID      (secret)  from your Hue developer "Remote API app"
//   HUE_CLIENT_SECRET  (secret)  from the same place
//   APP_PIN            (secret)  the PIN phrase you type into Halo on the glasses
//   ALLOWED_ORIGINS    (text)    your Pages address, e.g. https://yourname.github.io
//   HUE_APP_ID         (text, optional) the "AppId" Hue shows for your app
// Binding (Worker > Settings > Bindings):
//   HUE_KV             a KV namespace (stores the Hue tokens)

const HUE = 'https://api.meethue.com';
const URLS = {
  authorize: `${HUE}/v2/oauth2/authorize`,
  token: `${HUE}/v2/oauth2/token`,
  routeApi: `${HUE}/route/api`,       // "classic" API through the cloud (used once, to create the app key)
  routeClip: `${HUE}/route/clip/v2`,  // CLIP v2 through the cloud (everything Halo does)
};

// Halo only ever needs these. Anything else is refused, so even someone who learned
// your PIN could not use this relay to, say, delete lights or change bridge settings.
const GET_OK = /^\/resource\/(light|grouped_light|room|zone|scene|bridge_home|device)(\/[0-9a-fA-F-]{36})?$/;
const PUT_OK = /^\/resource\/(light|grouped_light|scene)\/[0-9a-fA-F-]{36}$/;

const REFRESH_MARGIN_MS = 60 * 60 * 1000; // refresh when < 1 hour of access token is left
const AUTH_KEY = 'hue:auth';

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      return await route(request, env, new URL(request.url), cors);
    } catch (e) {
      return json({ error: 'relay_error', message: String((e && e.message) || e) }, 500, cors);
    }
  },
};

async function route(request, env, url, cors) {
  const p = url.pathname;
  if (p === '/') return text('Halo relay is running.', 200, cors);
  if (p === '/auth/start') return authStart(request, env);
  if (p === '/auth/callback') return authCallback(env, url);

  if (p === '/status') {
    if (!(await pinOk(request, env))) return json({ error: 'bad_pin' }, 401, cors);
    const a = await getAuth(env);
    return json({ ok: true, linked: !!a }, 200, cors);
  }
  if (p.startsWith('/clip/v2/')) return proxy(request, env, p.slice('/clip/v2'.length), cors);
  return json({ error: 'not_found' }, 404, cors);
}

// ------------------------------------------------------------------ helpers
export function normalisePin(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function sha256(s) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function pinOk(request, env) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  const want = normalisePin(env.APP_PIN);
  if (!m || !want) return false;
  return safeEqual(normalisePin(m[1]), want);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  const h = { Vary: 'Origin' };
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, PUT, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

const json = (obj, status, cors) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const text = (s, status, cors) =>
  new Response(s, { status, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' } });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:18px/1.45 system-ui,sans-serif;background:#111;color:#f3f3f3;margin:0;padding:28px;max-width:520px}
h1{font-size:1.4rem}input,button{font:inherit;padding:12px 14px;border-radius:12px;border:1px solid #555;background:#1d1d22;color:#fff;width:100%;box-sizing:border-box;margin:8px 0}
button{background:#ffb347;color:#1a1100;border:0;font-weight:700}.ok{color:#7be3a1}.bad{color:#ff8a8a}</style></head>
<body><h1>${esc(title)}</h1>${body}</body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

// ----------------------------------------------------------- token storage
async function getAuth(env) {
  const raw = await env.HUE_KV.get(AUTH_KEY);
  return raw ? JSON.parse(raw) : null;
}
const saveAuth = (env, a) => env.HUE_KV.put(AUTH_KEY, JSON.stringify(a));
const expiresInSeconds = (j) => Number(j.expires_in ?? j.access_token_expires_in ?? 604800) || 604800;

async function tokenRequest(env, form) {
  const basic = btoa(`${env.HUE_CLIENT_ID}:${env.HUE_CLIENT_SECRET}`);
  const res = await fetch(URLS.token, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.access_token) throw new Error(`Hue token request failed (${res.status})`);
  return j;
}

async function refreshAuth(env, a) {
  const j = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
  const next = {
    ...a,
    access_token: j.access_token,
    refresh_token: j.refresh_token || a.refresh_token,
    expires_at: Date.now() + expiresInSeconds(j) * 1000,
  };
  await saveAuth(env, next);
  return next;
}

/** Returns auth, 'expired' (could not refresh and the token is dead), or null (never linked). */
async function freshAuth(env) {
  let a = await getAuth(env);
  if (!a) return null;
  if (a.expires_at - Date.now() < REFRESH_MARGIN_MS) {
    try { a = await refreshAuth(env, a); } catch { if (a.expires_at <= Date.now()) return 'expired'; }
  }
  return a;
}

// --------------------------------------------------------- one-time linking
async function authStart(request, env) {
  if (request.method === 'POST') {
    const form = await request.formData();
    const pin = normalisePin(form.get('pin'));
    if (!pin || !(await safeEqual(pin, normalisePin(env.APP_PIN)))) {
      return page('Halo relay', '<p class="bad">That PIN phrase is not right.</p><p><a href="" style="color:#ffb347">Try again</a></p>', 401);
    }
    const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.HUE_KV.put(`state:${state}`, '1', { expirationTtl: 600 });
    const q = new URLSearchParams({ client_id: env.HUE_CLIENT_ID, response_type: 'code', state });
    if (env.HUE_APP_ID) q.set('appid', env.HUE_APP_ID);
    return Response.redirect(`${URLS.authorize}?${q}`, 302);
  }
  return page('Link Halo to Hue', `<p>Enter the PIN phrase you chose for Halo, then sign in to your Philips Hue account on the next page.</p>
<form method="post"><input name="pin" type="password" autocomplete="off" placeholder="PIN phrase" required><button>Continue to Hue</button></form>`);
}

async function authCallback(env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return page('Halo relay', '<p class="bad">This page is only for finishing the Hue sign-in.</p>', 400);
  const known = await env.HUE_KV.get(`state:${state}`);
  if (!known) return page('Halo relay', '<p class="bad">That sign-in link expired. Start again from <b>/auth/start</b>.</p>', 400);
  await env.HUE_KV.delete(`state:${state}`);
  try {
    const tok = await tokenRequest(env, { grant_type: 'authorization_code', code });
    const username = await createAppKey(tok.access_token);
    await saveAuth(env, {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at: Date.now() + expiresInSeconds(tok) * 1000,
      username,
      linked_at: new Date().toISOString(),
    });
    return page('Linked', '<p class="ok">Halo is linked to your Hue system.</p><p>You can close this page and open Halo on your glasses.</p>');
  } catch (e) {
    return page('Could not link', `<p class="bad">${esc(e.message)}</p><p>Check your Client ID/Secret and that the Callback URL in your Hue app is exactly this worker's <b>/auth/callback</b> address.</p>`, 502);
  }
}

/** Presses the bridge's "virtual link button" through the cloud, then asks for an app key. */
async function createAppKey(accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const press = await fetch(`${URLS.routeApi}/0/config`, { method: 'PUT', headers, body: JSON.stringify({ linkbutton: true }) });
  if (!press.ok) throw new Error(`Hue would not press the link button (${press.status})`);
  const made = await fetch(URLS.routeApi, { method: 'POST', headers, body: JSON.stringify({ devicetype: 'halo-glasses' }) });
  const j = await made.json().catch(() => null);
  const username = Array.isArray(j) && j[0] && j[0].success && j[0].success.username;
  if (!username) throw new Error('Hue did not hand back an app key');
  return username;
}

// ------------------------------------------------------------------- proxy
async function proxy(request, env, path, cors) {
  if (!(await pinOk(request, env))) return json({ error: 'bad_pin' }, 401, cors);
  const method = request.method;
  if (method === 'GET') { if (!GET_OK.test(path)) return json({ error: 'not_allowed' }, 404, cors); }
  else if (method === 'PUT') { if (!PUT_OK.test(path)) return json({ error: 'not_allowed' }, 404, cors); }
  else return json({ error: 'method_not_allowed' }, 405, cors);

  let body;
  if (method === 'PUT') {
    body = await request.text();
    if (body.length > 2048) return json({ error: 'too_large' }, 413, cors);
  }

  let a = await freshAuth(env);
  if (!a) return json({ error: 'not_linked' }, 503, cors);
  if (a === 'expired') return json({ error: 'hue_auth' }, 502, cors);

  let up = await callHue(a, method, path, body);
  if (up.status === 401 || up.status === 403) {
    try { a = await refreshAuth(env, a); } catch { return json({ error: 'hue_auth' }, 502, cors); }
    up = await callHue(a, method, path, body);
    if (up.status === 401 || up.status === 403) return json({ error: 'hue_auth' }, 502, cors);
  }
  return new Response(up.body, {
    status: up.status,
    headers: { ...cors, 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' },
  });
}

function callHue(a, method, path, body) {
  return fetch(`${URLS.routeClip}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${a.access_token}`,
      'hue-application-key': a.username,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body,
  });
}
