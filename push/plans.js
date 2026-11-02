// Shared meal plans ("SHARE MY WEEK", 2 Nov 2026): your week's dinners and the shopping list, shared with friends (a partner,
// housemates). Everyone on it can change it; a change to the meals tells the others ("Dex changed Thursday: Lasagne soup").
// Shopping ticks sync too but never alert (too chatty in the shop). One shared week per person at a time.
// Kept here: the plan (7 nights of { r: recipe id, n: servings, lunch, kids }), which shopping items are ticked, your extras.
// Every route is POST JSON with { secret }:
//   /p/mine   {}                                    -> { me, plan: { id, ver, owner, members, plan, have, extra } | null }
//   /p/share  { to: [ids], plan, have, extra }      start one (or add people to yours); they get "Dex shared their week's meals with you"
//   /p/save   { id, days: { '0'..'6': night|null }, have: { key: bool }, extra: [..]|undefined, note }   -> { plan }
//             days and have are CHANGES (merged in, so two phones ticking in the shop don't undo each other); note is the alert words
//   /p/leave  { id }                                stop sharing (you keep a copy); the last one out deletes it
import { init, hash, alert } from './friends.js';
import { cleanText } from './lists.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, owner TEXT NOT NULL, data TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1, updated INTEGER, by TEXT)',
  'CREATE TABLE IF NOT EXISTS plan_members (plan TEXT NOT NULL, user TEXT NOT NULL, at INTEGER, PRIMARY KEY (plan, user))',
  'CREATE INDEX IF NOT EXISTS plan_members_user ON plan_members (user)',
];
let ready = null;
const initP = (env) => ready || (ready = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { ready = null; throw e; }));
const MAX_MEMBERS = 6;
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
const key = (s) => String(s || '').replace(/[^a-z0-9_.:~|-]/gi, '').slice(0, 80);
const night = (p) => (p && typeof p === 'object' && key(p.r) ? { r: key(p.r), n: Math.max(1, Math.min(20, Math.floor(+p.n) || 2)), lunch: !!p.lunch, kids: !!p.kids } : null);
const cleanPlan = (a) => Array.from({ length: 7 }, (_, i) => night(Array.isArray(a) ? a[i] : null));
const cleanHave = (h) => { const o = {}; if (h && typeof h === 'object') for (const k of Object.keys(h).slice(0, 400)) { const kk = key(k); if (kk) o[kk] = !!h[k]; } return o; };
const cleanExtra = (x) => (Array.isArray(x) ? x : []).slice(0, 60).map((e) => ({ id: key(e && e.id) || rid(), t: cleanText(e && e.t, 60), have: !!(e && e.have) })).filter((e) => e.t);

export async function plans(path, b, env, out) {
  if (!env.DB) return out({ error: 'friends not set up' }, 503);
  await init(env); await initP(env);
  const secret = String(b.secret || '');
  if (secret.length < 32 || secret.length > 128) return out({ error: 'bad secret' }, 400);
  const me = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(await hash(secret)).first();
  if (!me) return out({ error: 'not registered' }, 401);
  const DB = env.DB, now = Date.now();
  const people = async (pid) => (await DB.prepare('SELECT u.id, u.name, u.plate, u.push FROM plan_members m JOIN users u ON u.id = m.user WHERE m.plan = ? ORDER BY m.at').bind(pid).all()).results;
  const mine = async () => DB.prepare('SELECT p.* FROM plans p JOIN plan_members m ON m.plan = p.id WHERE m.user = ? ORDER BY m.at DESC LIMIT 1').bind(me.id).first();
  const view = async (P) => { if (!P) return null; const d = JSON.parse(P.data || '{}'), mem = await people(P.id);
    return { id: P.id, ver: P.ver, owner: P.owner, by: P.by, updated: P.updated, members: mem.map((u) => ({ id: u.id, name: u.name, plate: u.plate })), plan: cleanPlan(d.plan), have: d.have || {}, extra: d.extra || [] }; };
  const tell = async (pid, msg) => { for (const u of await people(pid)) if (u.id !== me.id) await alert(env, u, Object.assign({ url: 'PlanWeek.html' }, msg)); };
  const friendsOf = async (ids) => { const ok = []; for (const id of [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).slice(0, 40)))]) if (id !== me.id && await DB.prepare('SELECT 1 FROM links WHERE a = ? AND b = ?').bind(me.id, id).first()) ok.push(id); return ok; };

  if (path === '/p/mine') return out({ ok: true, me: { id: me.id, name: me.name }, plan: await view(await mine()) });

  if (path === '/p/share') {
    const to = await friendsOf(b.to); if (!to.length) return out({ error: 'pick a friend' }, 400);
    let P = await mine();
    if (!P) { const id = rid(); const data = { plan: cleanPlan(b.plan), have: cleanHave(b.have), extra: cleanExtra(b.extra) };
      await DB.batch([DB.prepare('INSERT INTO plans (id, owner, data, ver, updated, by) VALUES (?, ?, ?, 1, ?, ?)').bind(id, me.id, JSON.stringify(data), now, me.id),
        DB.prepare('INSERT INTO plan_members (plan, user, at) VALUES (?, ?, ?)').bind(id, me.id, now)]);
      P = await DB.prepare('SELECT * FROM plans WHERE id = ?').bind(id).first(); }
    const have = (await people(P.id)).length;
    for (const id of to.slice(0, Math.max(0, MAX_MEMBERS - have))) {
      const prev = await DB.prepare('SELECT p.id FROM plans p JOIN plan_members m ON m.plan = p.id WHERE m.user = ?').bind(id).first();
      if (prev && prev.id !== P.id) continue;   // already sharing a week with someone else
      await DB.prepare('INSERT OR IGNORE INTO plan_members (plan, user, at) VALUES (?, ?, ?)').bind(P.id, id, now).run();
      const u = await DB.prepare('SELECT id, name, push FROM users WHERE id = ?').bind(id).first();
      if (u) await alert(env, u, { url: 'PlanWeek.html', title: me.name + ' shared their week’s meals with you', body: 'See what’s for dinner and share the shopping list', tag: 'plan-' + P.id });
    }
    return out({ ok: true, plan: await view(P) });
  }

  const P = await DB.prepare('SELECT p.* FROM plans p JOIN plan_members m ON m.plan = p.id WHERE p.id = ? AND m.user = ?').bind(String(b.id || '').slice(0, 40), me.id).first();
  if (!P) return out({ error: 'not found' }, 404);

  if (path === '/p/save') {
    const d = JSON.parse(P.data || '{}'); d.plan = cleanPlan(d.plan); d.have = d.have || {}; let changed = false;
    if (b.days && typeof b.days === 'object') for (const k of Object.keys(b.days)) if (/^[0-6]$/.test(k)) { d.plan[+k] = night(b.days[k]); changed = true; }
    Object.assign(d.have, cleanHave(b.have));
    if (Array.isArray(b.extra)) d.extra = cleanExtra(b.extra);
    await DB.prepare('UPDATE plans SET data = ?, ver = ver + 1, updated = ?, by = ? WHERE id = ?').bind(JSON.stringify(d), now, me.id, P.id).run();
    const note = cleanText(b.note, 110);
    if (changed && note) await tell(P.id, { title: me.name + ' changed your week', body: note, tag: 'plan-' + P.id });
    return out({ ok: true, plan: await view(await DB.prepare('SELECT * FROM plans WHERE id = ?').bind(P.id).first()) });
  }
  if (path === '/p/leave') {
    await DB.prepare('DELETE FROM plan_members WHERE plan = ? AND user = ?').bind(P.id, me.id).run();
    const left = (await DB.prepare('SELECT COUNT(*) AS n FROM plan_members WHERE plan = ?').bind(P.id).first()).n;
    if (!left) await DB.prepare('DELETE FROM plans WHERE id = ?').bind(P.id).run();
    else if (P.owner === me.id) { const nx = await DB.prepare('SELECT user FROM plan_members WHERE plan = ? ORDER BY at LIMIT 1').bind(P.id).first(); if (nx) await DB.prepare('UPDATE plans SET owner = ? WHERE id = ?').bind(nx.user, P.id).run(); }
    return out({ ok: true });
  }
  return out({ error: 'not found' }, 404);
}
