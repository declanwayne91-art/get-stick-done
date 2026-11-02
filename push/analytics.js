// Usage counts (analytics) for Get St*ck Done!: anonymous, counts only. See the "analytics plan" doc.
// - The phone keeps a random install id (gsd.aid, never linked to a name, friend code or list) and a queue of
//   { day, event, detail } -> count, sent in one go when the app is put away (POST /a/e, sendBeacon, text/plain).
// - Stored in D1 as one row per day / install / event / detail with a count: no times, no text anyone typed.
// - Kept 13 months (tidied by the nightly cron). Switched off on the phone = nothing is sent (Me > settings).
// - The dashboard (app/stats.html) asks POST /a/stats with the admin key: totals and shares only, worked out here.
//   The key's SHA-256 hash is STATS_HASH in push/wrangler.toml; only Dex has the key itself.
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS a_ev (day TEXT NOT NULL, id TEXT NOT NULL, ev TEXT NOT NULL, d TEXT NOT NULL DEFAULT \'\', n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, id, ev, d))',
  'CREATE INDEX IF NOT EXISTS a_ev_day ON a_ev (day)',
  'CREATE TABLE IF NOT EXISTS a_inst (id TEXT PRIMARY KEY, first TEXT NOT NULL, last TEXT NOT NULL, ver TEXT)',
  'CREATE TABLE IF NOT EXISTS a_admin (k TEXT PRIMARY KEY, at INTEGER)',
];
let ready = null;
const init = (env) => ready || (ready = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { ready = null; throw e; }));

// the only events the app sends (anything else is dropped)
export const EVENTS = ['app_open', 'screen', 'onboard_step', 'task_add', 'task_done', 'workout_done', 'cook_done', 'water_goal', 'sticker_stuck',
  'pack_opened', 'pin_earned', 'book_open', 'friend_invite', 'friend_added', 'cheer_sent', 'list_shared', 'notif_choice', 'notif_open', 'start_fresh', 'error', 'analytics_off'];
const okDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function analytics(path, b, env, out) {
  if (!env.DB) return out({ error: 'not set up' }, 503);
  await init(env);
  if (path === '/a/e') {
    const id = String(b.id || ''); if (!/^[a-z0-9]{16,40}$/.test(id)) return out({ error: 'bad id' }, 400);
    const lo = daysAgo(10), hi = daysAgo(-1), ver = String(b.v || '').slice(0, 20);
    const rows = (Array.isArray(b.ev) ? b.ev : []).slice(0, 300).filter((r) => Array.isArray(r) && okDay(r[0]) && r[0] >= lo && r[0] <= hi && EVENTS.includes(r[1]))
      .map((r) => [r[0], r[1], String(r[2] == null ? '' : r[2]).replace(/[^a-z0-9_.:~-]/gi, '').slice(0, 40), Math.max(1, Math.min(500, Math.floor(+r[3]) || 1))]);
    if (!rows.length) return out({ ok: true, n: 0 });
    const first = rows.reduce((m, r) => (r[0] < m ? r[0] : m), rows[0][0]), last = rows.reduce((m, r) => (r[0] > m ? r[0] : m), rows[0][0]);
    const q = rows.map((r) => env.DB.prepare('INSERT INTO a_ev (day, id, ev, d, n) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, id, ev, d) DO UPDATE SET n = n + excluded.n').bind(r[0], id, r[1], r[2], r[3]));
    q.push(env.DB.prepare('INSERT INTO a_inst (id, first, last, ver) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET first = MIN(first, excluded.first), last = MAX(last, excluded.last), ver = excluded.ver').bind(id, first, last, ver));
    await env.DB.batch(q); return out({ ok: true, n: rows.length });
  }
  if (path === '/a/forget') {   // switching analytics off deletes what this phone sent
    const id = String(b.id || ''); if (!/^[a-z0-9]{16,40}$/.test(id)) return out({ error: 'bad id' }, 400);
    await env.DB.batch([env.DB.prepare('DELETE FROM a_ev WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM a_inst WHERE id = ?').bind(id)]);
    return out({ ok: true });
  }
  if (path === '/a/stats') {
    const k = String(b.key || ''), h = k ? await sha(k) : '';   // the key's hash is in wrangler.toml (STATS_HASH),
    if (!k || !((env.STATS_HASH && h === env.STATS_HASH) || await env.DB.prepare('SELECT 1 FROM a_admin WHERE k = ?').bind(h).first())) return out({ error: 'no' }, 401);
    return out(await stats(env, Math.max(7, Math.min(400, Math.floor(+b.days) || 56))));
  }
  return out({ error: 'not found' }, 404);
}

async function stats(env, days) {
  // everything is added up here, so the dashboard only ever gets totals and shares, never an install's own rows
  const DB = env.DB, from = daysAgo(days - 1), all = (sql, ...a) => DB.prepare(sql).bind(...a).all().then((r) => r.results);
  const act = await all("SELECT day, id, SUM(CASE WHEN ev IN ('task_done','workout_done','cook_done','water_goal') THEN n ELSE 0 END) AS done FROM a_ev WHERE day >= ? GROUP BY day, id", daysAgo(Math.max(days, 70) - 1));
  const inst = await all('SELECT id, first, last, ver FROM a_inst WHERE last >= ?', daysAgo(Math.max(days, 70) + 40));
  const ev = await all('SELECT ev, d, SUM(n) AS n, COUNT(DISTINCT id) AS people FROM a_ev WHERE day >= ? GROUP BY ev, d', from);
  const reach = await all("SELECT d, COUNT(DISTINCT id) AS people FROM a_ev WHERE ev = 'screen' AND day >= ? GROUP BY d", daysAgo(6));
  // new installs in the window: how far each got (finished setup = onboarding step 6; did something; stuck a sticker)
  const fq = (w) => DB.prepare('SELECT COUNT(DISTINCT id) AS n FROM a_ev WHERE ' + w + ' AND id IN (SELECT id FROM a_inst WHERE first >= ?)').bind(from).first().then((r) => r.n);
  const funnel = { setup: await fq("ev = 'onboard_step' AND d = '6'"), did: await fq("ev IN ('task_done','workout_done','cook_done','water_goal')"), stuck: await fq("ev = 'sticker_stuck'") };
  const total = (await DB.prepare('SELECT COUNT(*) AS n FROM a_inst').first()).n;
  const D = (s) => new Date(s + 'T00:00:00Z'), add = (s, n) => new Date(D(s).getTime() + n * 864e5).toISOString().slice(0, 10);
  const monday = (s) => { const d = D(s), w = (d.getUTCDay() + 6) % 7; return add(s, -w); };
  const byDay = {}, seen = {}; act.forEach((r) => { (byDay[r.day] = byDay[r.day] || { u: new Set(), d: new Set() }).u.add(r.id); if (r.done > 0) byDay[r.day].d.add(r.id); (seen[r.id] = seen[r.id] || new Set()).add(r.day); });
  const t = today(), daily = []; for (let i = days - 1; i >= 0; i--) { const k = daysAgo(i), x = byDay[k]; daily.push({ day: k, users: x ? x.u.size : 0, doers: x ? x.d.size : 0 }); }
  const weeks = {}; act.forEach((r) => { if (r.day < from) return; const w = monday(r.day); const W = (weeks[w] = weeks[w] || { u: new Set(), d: new Set(), dd: {} }); W.u.add(r.id); if (r.done > 0) { W.d.add(r.id); W.dd[r.id] = (W.dd[r.id] || 0) + 1; } });
  const fresh = {}; inst.forEach((x) => { if (x.first >= from) { const w = monday(x.first); fresh[w] = (fresh[w] || 0) + 1; } });
  const weekly = Object.keys({ ...weeks, ...fresh }).sort().map((w) => { const W = weeks[w] || { u: new Set(), d: new Set(), dd: {} }, dv = Object.values(W.dd);
    return { week: w, users: W.u.size, doers: W.d.size, daysPerDoer: dv.length ? Math.round(10 * dv.reduce((a, b) => a + b, 0) / dv.length) / 10 : 0, newInstalls: fresh[w] || 0 }; });
  const last = (n) => new Set(act.filter((r) => r.day >= daysAgo(n - 1)).map((r) => r.id)).size;
  const dau7 = daily.slice(-7).reduce((a, b) => a + b.users, 0) / 7, mau = last(30);
  // classic day-N retention: of installs whose first day is old enough, the share active exactly N days later
  const ret = (N) => { const c = inst.filter((x) => x.first <= daysAgo(N) && x.first >= daysAgo(N + 60)); if (!c.length) return null; return { n: c.length, pct: Math.round(100 * c.filter((x) => seen[x.id] && seen[x.id].has(add(x.first, N))).length / c.length) }; };
  // weekly cohorts: installs grouped by the week they started; share active in each later week
  const cohorts = Object.keys(fresh).sort().slice(-8).map((w) => { const ids = inst.filter((x) => x.first >= w && x.first < add(w, 7)).map((x) => x.id);
    const cells = []; for (let k = 0; k <= 8; k++) { const ws = add(w, 7 * k); if (ws > t) break; const we = add(ws, 7); cells.push(Math.round(100 * ids.filter((id) => seen[id] && [...seen[id]].some((d) => d >= ws && d < we)).length / ids.length)); }
    return { week: w, n: ids.length, cells }; });
  const vers = {}; inst.filter((x) => x.last >= daysAgo(6)).forEach((x) => { vers[x.ver || '?'] = (vers[x.ver || '?'] || 0) + 1; });
  return { ok: true, today: t, from, days, installs: total, dauMau: mau ? Math.round(100 * dau7 / mau) : 0, mau, wau: last(7), retention: { d1: ret(1), d7: ret(7), d30: ret(30) },
    daily, weekly, cohorts, ev, reach, funnel, newInstalls: inst.filter((x) => x.first >= from).length, versions: vers };
}

export async function tidyAnalytics(env) {   // 13 months, then gone
  if (!env.DB) return; await init(env); const cut = daysAgo(396);
  await env.DB.batch([env.DB.prepare('DELETE FROM a_ev WHERE day < ?').bind(cut), env.DB.prepare('DELETE FROM a_inst WHERE last < ?').bind(cut)]);
}
