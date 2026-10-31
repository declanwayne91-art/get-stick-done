// Shared lists ("IT TAKES TWO"): a to-do list you share with friends. Anyone on it can add, change, call dibs on ("CALLED IT!"),
// set for someone ("for Sam") and tick anything; everyone else on it gets an alert when something's ticked off.
// Friends only: you can only put people on a list who are your friends. Only what's on a shared list is kept here.
// Repeat: 'once', 'day' or 'week' (fills back up each day / each Monday, UTC).
// Every route is POST JSON with { secret }:
//   /l/mine   {}                                   -> { me, lists: [{ id, name, rep, owner, members, items }] }
//   /l/new    { name, rep, members: [ids], items: [{ t, size }] } -> { list }   they get "Dex shared a list with you: House"
//   /l/invite { list, members: [ids] }             add more friends to a list
//   /l/add    { list, t, size, for }               /l/edit { list, item, t?, size?, for? }   /l/del { list, item }
//   /l/tick   { list, item, done }                 the others get "Sam ticked off “Clean the bathroom”"
//   /l/call   { list, item, on }                   CALLED IT! (dibs), or let it go
//   /l/leave  { list }                             the last one out deletes it
import { init, hash, alert } from './friends.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL, rep TEXT NOT NULL, period TEXT, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS members (list TEXT NOT NULL, user TEXT NOT NULL, at INTEGER, PRIMARY KEY (list, user))',
  'CREATE INDEX IF NOT EXISTS members_user ON members (user)',
  'CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, list TEXT NOT NULL, t TEXT NOT NULL, size TEXT, by TEXT, at INTEGER, for_id TEXT, dibs TEXT, done_by TEXT, done_at INTEGER, ord INTEGER)',
  'CREATE INDEX IF NOT EXISTS items_list ON items (list)',
];
let ready = null;
const initL = (env) => ready || (ready = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { ready = null; throw e; }));
const MAX_LISTS = 20, MAX_MEMBERS = 8, MAX_ITEMS = 150, REPS = ['once', 'day', 'week'], SIZES = ['q', 'm', 'b'];
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
export const cleanText = (t, n) => String(t || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n || 60);
export function period(rep, now) {
  const d = new Date(now == null ? Date.now() : now);
  if (rep === 'day') return d.toISOString().slice(0, 10);
  if (rep === 'week') { const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))); return 'w' + m.toISOString().slice(0, 10); }
  return '-';
}

export async function lists(path, b, env, out) {
  if (!env.DB) return out({ error: 'friends not set up' }, 503);
  await init(env); await initL(env);
  const secret = String(b.secret || '');
  if (secret.length < 32 || secret.length > 128) return out({ error: 'bad secret' }, 400);
  const me = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(await hash(secret)).first();
  if (!me) return out({ error: 'not registered' }, 401);
  const now = Date.now(), DB = env.DB;
  const friendsOf = async (ids) => { ids = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).slice(0, 40)))].filter((x) => x && x !== me.id);
    const ok = []; for (const id of ids) if (await DB.prepare('SELECT 1 FROM links WHERE a = ? AND b = ?').bind(me.id, id).first()) ok.push(id); return ok; };
  const memberOf = async (lid) => { const L = await DB.prepare('SELECT l.* FROM lists l JOIN members m ON m.list = l.id WHERE l.id = ? AND m.user = ?').bind(String(lid || '').slice(0, 40), me.id).first(); return L || null; };
  const roll = async (L) => { const p = period(L.rep, now); if (L.rep === 'once' || L.period === p) return L;   // a new day / week: the list fills back up
    await DB.batch([DB.prepare('UPDATE items SET done_by = NULL, done_at = NULL, dibs = NULL WHERE list = ?').bind(L.id), DB.prepare('UPDATE lists SET period = ? WHERE id = ?').bind(p, L.id)]); L.period = p; return L; };
  const people = async (lid) => (await DB.prepare('SELECT u.id, u.name, u.plate, u.push FROM members m JOIN users u ON u.id = m.user WHERE m.list = ? ORDER BY m.at').bind(lid).all()).results;
  const view = async (L) => { await roll(L); const mem = await people(L.id);
    const items = (await DB.prepare('SELECT id, t, size, by, at, for_id, dibs, done_by, done_at FROM items WHERE list = ? ORDER BY ord, at').bind(L.id).all()).results
      .map((x) => ({ id: x.id, t: x.t, size: x.size || '', by: x.by, at: x.at, for: x.for_id || null, dibs: x.dibs || null, done: x.done_by || null, doneAt: x.done_at || null }));
    return { id: L.id, name: L.name, rep: L.rep, owner: L.owner, period: L.period, members: mem.map((u) => ({ id: u.id, name: u.name, plate: u.plate })), items }; };
  const tell = async (L, msg, skip) => { for (const u of await people(L.id)) if (u.id !== me.id && u.id !== skip) await alert(env, u, Object.assign({ url: 'MyList.html' }, msg)); };
  const item = async (L, iid) => DB.prepare('SELECT * FROM items WHERE id = ? AND list = ?').bind(String(iid || '').slice(0, 40), L.id).first();
  const forId = async (L, v) => { if (!v) return null; return (await DB.prepare('SELECT 1 FROM members WHERE list = ? AND user = ?').bind(L.id, String(v).slice(0, 40)).first()) ? String(v).slice(0, 40) : null; };

  if (path === '/l/mine') {
    const ls = (await DB.prepare('SELECT l.* FROM lists l JOIN members m ON m.list = l.id WHERE m.user = ? ORDER BY m.at').bind(me.id).all()).results;
    const outL = []; for (const L of ls) outL.push(await view(L));
    return out({ ok: true, me: me.id, lists: outL });
  }
  if (path === '/l/new') {
    const name = cleanText(b.name, 24) || 'Our list', rep = REPS.includes(b.rep) ? b.rep : 'once';
    const mine = (await DB.prepare('SELECT COUNT(*) AS n FROM members WHERE user = ?').bind(me.id).first()).n; if (mine >= MAX_LISTS) return out({ error: 'too many lists' }, 400);
    const who = (await friendsOf(b.members)).slice(0, MAX_MEMBERS - 1); if (!who.length) return out({ error: 'pick a friend' }, 400);
    const id = rid(), q = [DB.prepare('INSERT INTO lists (id, name, owner, rep, period, created) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, me.id, rep, period(rep, now), now)];
    [me.id, ...who].forEach((u, i) => q.push(DB.prepare('INSERT INTO members (list, user, at) VALUES (?, ?, ?)').bind(id, u, now + i)));
    const its = (Array.isArray(b.items) ? b.items : []).slice(0, MAX_ITEMS).map((x) => ({ t: cleanText(x && x.t), size: SIZES.includes(x && x.size) ? x.size : '' })).filter((x) => x.t);
    its.forEach((x, i) => q.push(DB.prepare('INSERT INTO items (id, list, t, size, by, at, ord) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(rid(), id, x.t, x.size, me.id, now, i)));
    await DB.batch(q);
    const L = await DB.prepare('SELECT * FROM lists WHERE id = ?').bind(id).first();
    await tell(L, { title: me.name + ' shared a list with you: ' + name, body: its.length ? its.length + (its.length === 1 ? ' thing' : ' things') + ' to tick off together' : 'Add what needs doing', tag: 'list-' + id });
    return out({ ok: true, list: await view(L) });
  }
  const L = await memberOf(b.list); if (!L) return out({ error: 'no such list' }, 404);
  await roll(L);
  if (path === '/l/invite') {
    const n = (await DB.prepare('SELECT COUNT(*) AS n FROM members WHERE list = ?').bind(L.id).first()).n;
    const who = (await friendsOf(b.members)).slice(0, Math.max(0, MAX_MEMBERS - n)); const fresh = [];
    for (const u of who) { const r = await DB.prepare('INSERT OR IGNORE INTO members (list, user, at) VALUES (?, ?, ?)').bind(L.id, u, now).run(); if (r.meta && r.meta.changes) fresh.push(u); }
    for (const u of fresh) { const them = await DB.prepare('SELECT id, push FROM users WHERE id = ?').bind(u).first(); await alert(env, them, { title: me.name + ' shared a list with you: ' + L.name, body: 'Tick it off together', tag: 'list-' + L.id, url: 'MyList.html' }); }
    return out({ ok: true, list: await view(L) });
  }
  if (path === '/l/add') {
    const t = cleanText(b.t); if (!t) return out({ error: 'empty' }, 400);
    const n = (await DB.prepare('SELECT COUNT(*) AS n, MAX(ord) AS o FROM items WHERE list = ?').bind(L.id).first()); if (n.n >= MAX_ITEMS) return out({ error: 'full' }, 400);
    await DB.prepare('INSERT INTO items (id, list, t, size, by, at, for_id, ord) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(rid(), L.id, t, SIZES.includes(b.size) ? b.size : '', me.id, now, await forId(L, b.for), (n.o || 0) + 1).run();
    return out({ ok: true, list: await view(L) });
  }
  if (path === '/l/leave') {
    await DB.prepare('DELETE FROM members WHERE list = ? AND user = ?').bind(L.id, me.id).run();
    await DB.prepare('UPDATE items SET for_id = NULL WHERE list = ? AND for_id = ?').bind(L.id, me.id).run();
    await DB.prepare('UPDATE items SET dibs = NULL WHERE list = ? AND dibs = ?').bind(L.id, me.id).run();
    const left = (await DB.prepare('SELECT COUNT(*) AS n FROM members WHERE list = ?').bind(L.id).first()).n;
    if (!left) await DB.batch([DB.prepare('DELETE FROM items WHERE list = ?').bind(L.id), DB.prepare('DELETE FROM lists WHERE id = ?').bind(L.id)]);
    return out({ ok: true });
  }
  const it = await item(L, b.item); if (!it) return out({ error: 'no such item' }, 404);
  if (path === '/l/edit') {
    const t = b.t != null ? cleanText(b.t) || it.t : it.t, size = b.size != null ? (SIZES.includes(b.size) ? b.size : '') : it.size, f = b.for !== undefined ? await forId(L, b.for) : it.for_id;
    await DB.prepare('UPDATE items SET t = ?, size = ?, for_id = ? WHERE id = ?').bind(t, size, f, it.id).run();
    return out({ ok: true, list: await view(L) });
  }
  if (path === '/l/del') { await DB.prepare('DELETE FROM items WHERE id = ?').bind(it.id).run(); return out({ ok: true, list: await view(L) }); }
  if (path === '/l/call') { await DB.prepare('UPDATE items SET dibs = ? WHERE id = ?').bind(b.on ? me.id : null, it.id).run(); return out({ ok: true, list: await view(L) }); }
  if (path === '/l/tick') {
    if (b.done) { if (it.done_by) return out({ ok: true, already: true, list: await view(L) });
      await DB.prepare('UPDATE items SET done_by = ?, done_at = ? WHERE id = ?').bind(me.id, now, it.id).run();
      const c = await DB.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN done_by IS NOT NULL THEN 1 ELSE 0 END) AS d FROM items WHERE list = ?').bind(L.id).first();
      await tell(L, c.d === c.n ? { title: L.name + ': all done!', body: me.name + ' ticked off the last one: ' + it.t, tag: 'list-' + L.id }
                                : { title: me.name + ' ticked off “' + it.t + '”', body: L.name + ' · ' + c.d + ' of ' + c.n + ' done', tag: 'list-' + L.id });
    } else if (it.done_by === me.id || !it.done_by) await DB.prepare('UPDATE items SET done_by = NULL, done_at = NULL WHERE id = ?').bind(it.id).run();
    return out({ ok: true, list: await view(L) });
  }
  return out({ error: 'not found' }, 404);
}
