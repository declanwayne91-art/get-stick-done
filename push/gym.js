// MY GYM DAYS morning nudge (gymdays.py in the app). Per phone (KV, binding SUBS, key gym:<id>): the push address, which
// weekdays (0 = Monday) with the words for each ("Leg day today 💪" / "LEG DAY is ready on Today. Tap to start."), the hour
// and the time zone, and the last day it sent. Nothing else. One nudge a day at most, sent by the 15-minute cron.
//   POST /g/set  { sub, days: { '0'..'6': [title, body] }, at: hour, tz }   save (no days = forget)
//   POST /g/off  { endpoint }                                              forget
import { push } from './send.js';

const WINDOW_MIN = 30;
const hour = (x) => (Number.isFinite(+x) ? Math.min(21, Math.max(5, Math.round(+x))) : 8);

export async function gym(path, b, env, out, idOf) {
  const endpoint = (b.sub && b.sub.endpoint) || b.endpoint || '';
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return out({ error: 'bad endpoint' }, 400);
  const id = 'gym:' + (await idOf(endpoint)).slice(4);
  if (path === '/g/off') { await env.SUBS.delete(id); return out({ ok: true }); }
  if (path === '/g/set') {
    const days = {};
    for (const k of Object.keys(b.days || {})) { const d = b.days[k]; if (/^[0-6]$/.test(k) && Array.isArray(d)) days[k] = [String(d[0] || 'Gym day today').slice(0, 60), String(d[1] || '').slice(0, 120)]; }
    if (!Object.keys(days).length) { await env.SUBS.delete(id); return out({ ok: true, n: 0 }); }
    const old = (await env.SUBS.get(id, 'json')) || {};
    await env.SUBS.put(id, JSON.stringify({ sub: { endpoint, keys: (b.sub && b.sub.keys) || {} }, days, at: hour(b.at), tz: String(b.tz || 'Europe/London').slice(0, 64), last: old.last || '' }));
    return out({ ok: true, n: Object.keys(days).length });
  }
  return out({ error: 'not found' }, 404);
}

// which nudge (if any) is due for this phone now: [title, body] and the day it's for
export function gymDue(rec, local, now = new Date()) {
  const t = local(rec.tz, now), wd = (new Date(t.day + 'T12:00:00Z').getUTCDay() + 6) % 7, d = rec.days && rec.days[wd];
  if (!d || rec.last === t.day) return null;
  const s = hour(rec.at) * 60;
  return t.min >= s && t.min < s + WINDOW_MIN ? { day: t.day, d } : null;
}

export async function runGym(env, local) {
  let cursor; const now = new Date();
  do {
    const page = await env.SUBS.list({ prefix: 'gym:', cursor }); cursor = page.list_complete ? null : page.cursor;
    for (const k of page.keys) {
      const rec = await env.SUBS.get(k.name, 'json'); if (!rec) continue;
      const due = gymDue(rec, local, now); if (!due) continue;
      const st = await push(env, rec.sub, 'gym', { t: 'gym', title: due.d[0], body: due.d[1] }).catch(() => 0);
      if (st === 404 || st === 410) { await env.SUBS.delete(k.name); continue; }
      rec.last = due.day; await env.SUBS.put(k.name, JSON.stringify(rec));
    }
  } while (cursor);
}
