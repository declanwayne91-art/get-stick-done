// Get St*ck Done! nudges: a tiny Cloudflare Worker that sends Hydro Homie's water nudges as Web Push, so they arrive
// even when the app is closed (and Android passes them on to a paired watch).
//
// What it keeps (KV, binding SUBS), per phone: the phone's anonymous push address, the nudge hours and time zone,
// today's glass count and goal (so it goes quiet once the goal is hit), and the last slot it sent. Nothing else.
// The push itself carries no data: the app's service worker writes the words ("Time for a glass", "3 of 6 today").
// Signing keys (VAPID) are made by the worker the first time it runs and kept in KV; GET /key hands out the public half.
//
// Routes (CORS: the app's origin only)
//   GET  /key          -> { key }                        the VAPID public key the app subscribes with
//   POST /subscribe    { sub, every, start, end, tz, goal }   save or update a phone
//   POST /unsubscribe  { endpoint }                      forget it
//   POST /drank        { endpoint, day, count, goal }    today's glasses (quiet once count >= goal)
//   POST /test         { endpoint }                      one nudge now, to check it works
//   POST /snooze       { endpoint, minutes }             IN 30 MIN on the nudge: one more nudge after that (if the goal isn't hit)
//   GET  /health       -> ok
//   POST /f/...        friends: see friends.js (D1, binding DB)
// Cron: every 15 minutes. Slots are start + every, start + 2*every ... up to end (8am-9pm every 2 h = 10, 12 ... 8pm).

import { friends, tidy } from './friends.js';

const ORIGINS = ['https://declanwayne91-art.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const WINDOW_MIN = 30;   // a slot can still be sent up to 30 min late (cron runs every 15)

import { push, vapid, b64u, utf8 } from './send.js';
export { push };
async function idOf(endpoint) { return 'sub:' + b64u(await crypto.subtle.digest('SHA-256', utf8(endpoint))).slice(0, 32); }

// local time in the phone's zone: { day: '2026-10-30', min: minutes since midnight }
export function local(tz, now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute) };
}

// which slot (if any) is due right now for this phone
export function dueSlot(rec, now = new Date()) {
  const t = local(rec.tz, now), every = Math.max(60, Math.round((+rec.every || 2) * 60));
  if (rec.day === t.day && rec.goal && rec.count >= rec.goal) return null;   // goal hit today: quiet
  if (rec.snooze && now.getTime() >= rec.snooze) return 'snooze@' + rec.snooze;   // IN 30 MIN came round
  for (let s = rec.start * 60 + every; s <= rec.end * 60; s += every) {
    if (t.min >= s && t.min < s + WINDOW_MIN) { const key = t.day + '@' + s; return rec.last === key ? null : key; }
  }
  return null;
}

async function run(env) {
  let cursor; const now = new Date();
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor }); cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      const rec = await env.SUBS.get(k.name, 'json'); if (!rec) continue;
      const slot = dueSlot(rec, now); if (!slot) continue;
      const st = await push(env, rec.sub).catch(() => 0);
      if (st === 404 || st === 410) { await env.SUBS.delete(k.name); continue; }
      if (slot.startsWith('snooze@')) delete rec.snooze; else rec.last = slot;
      rec.sent = (rec.sent || 0) + 1; await env.SUBS.put(k.name, JSON.stringify(rec));
    }
  } while (cursor);
}

const clamp = (x, lo, hi, d) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : d);

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '', cors = { 'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0], 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', Vary: 'Origin' };
    const out = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const path = new URL(req.url).pathname;
    try {
      if (req.method === 'GET' && path === '/health') return out({ ok: true });
      if (req.method === 'GET' && path === '/key') return out({ key: (await vapid(env)).pub });
      if (req.method !== 'POST') return out({ error: 'not found' }, 404);
      const b = await req.json().catch(() => ({}));
      if (path.startsWith('/f/')) return await friends(path, b, env, out);
      const endpoint = (b.sub && b.sub.endpoint) || b.endpoint || '';
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return out({ error: 'bad endpoint' }, 400);
      const id = await idOf(endpoint);
      if (path === '/subscribe') {
        const old = (await env.SUBS.get(id, 'json')) || {};
        const rec = { ...old, sub: { endpoint, keys: (b.sub && b.sub.keys) || {} }, every: clamp(b.every, 1, 6, 2), start: clamp(b.start, 0, 23, 8), end: clamp(b.end, 1, 24, 21), tz: String(b.tz || 'Europe/London').slice(0, 64), goal: clamp(b.goal, 1, 20, 6), at: old.at || Date.now() };
        await env.SUBS.put(id, JSON.stringify(rec)); return out({ ok: true });
      }
      if (path === '/unsubscribe') { await env.SUBS.delete(id); return out({ ok: true }); }
      const rec = await env.SUBS.get(id, 'json'); if (!rec) return out({ error: 'not subscribed' }, 404);
      if (path === '/drank') { rec.day = String(b.day || '').slice(0, 10); rec.count = clamp(b.count, 0, 50, 0); if (b.goal) rec.goal = clamp(b.goal, 1, 20, 6); await env.SUBS.put(id, JSON.stringify(rec)); return out({ ok: true }); }
      if (path === '/snooze') { rec.snooze = Date.now() + clamp(b.minutes, 10, 180, 30) * 60000; await env.SUBS.put(id, JSON.stringify(rec)); return out({ ok: true }); }
      if (path === '/test') { const st = await push(env, rec.sub, 'test'); return out({ ok: st >= 200 && st < 300, status: st }); }
      return out({ error: 'not found' }, 404);
    } catch (e) { return out({ error: 'server' }, 500); }
  },
  async scheduled(evt, env, ctx) { ctx.waitUntil(run(env)); if (new Date().getUTCHours() === 4 && new Date().getUTCMinutes() < 15) ctx.waitUntil(tidy(env).catch(() => {})); },
};
