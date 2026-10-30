// Friends, on the same worker as the nudges. D1 (binding DB) keeps: who's who (an anonymous id, a hash of the phone's secret,
// the friend code and the name plate: name, plate colour, level, favourite sticker and pin), who's friends with whom, blocks,
// and cheers waiting to be seen. Nothing else: no tasks, meals, weights or water ever leave the phone.
// Every route is POST JSON with { secret } (made on the phone, never stored here, only its SHA-256).
//   /f/me     { secret, plate }  -> { code }           register or update your name plate
//   /f/peek   { secret, code }   -> { friend }         whose code is this? (for the "add Dex?" card)
//   /f/add    { secret, code }   -> { friend }         become friends (both ways); they get a "hello"
//   /f/list   { secret }         -> { friends, inbox } your friends and cheers you haven't seen
//   /f/seen   { secret, id }                           you've seen that one
//   /f/cheer  { secret, to, c }                        send a cheer (c = which one)
//   /f/remove { secret, id }   /f/block { secret, id } (block = remove, and they can't add you again)
//   /f/push   { secret, sub }                          friend alerts: this phone's push subscription (null = off)
// A new friend or a cheer sends that friend an encrypted push (send.js): "Dex sent you a cheer!" / "NICE ONE!".

import { push } from './send.js';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, key TEXT UNIQUE NOT NULL, code TEXT UNIQUE NOT NULL, name TEXT, plate TEXT, lv INTEGER, st TEXT, pin TEXT, created INTEGER, seen INTEGER)',
  'CREATE TABLE IF NOT EXISTS links (a TEXT NOT NULL, b TEXT NOT NULL, at INTEGER, PRIMARY KEY (a, b))',
  'CREATE TABLE IF NOT EXISTS blocks (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b))',
  'CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, dest TEXT NOT NULL, src TEXT NOT NULL, kind TEXT NOT NULL, c INTEGER, at INTEGER, seen INTEGER DEFAULT 0)',
  'CREATE INDEX IF NOT EXISTS events_dest ON events (dest, seen)',
  'CREATE INDEX IF NOT EXISTS events_src ON events (src, at)',
];
let ready = null;
const init = (env) => ready || (ready = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)))
  .then(() => env.DB.prepare('ALTER TABLE users ADD COLUMN push TEXT').run().catch(() => {}))   // friend alerts: the phone's push address (added later; already there = fine)
  .catch((e) => { ready = null; throw e; }));

const ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no 0/O, 1/I/L
const PLATES = ['cream', 'lime', 'pink', 'sky', 'holo', 'sunset', 'gold', 'aurora', 'galaxy'];   // makeprofile.py PLATES (+ levelart.py)
const MAX_FRIENDS = 100, CHEERS_A_DAY = 60, CHEER_GAP = 30e3;
const rand = (n, abc = ABC) => { const b = crypto.getRandomValues(new Uint8Array(n)); return Array.from(b, (x) => abc[x % abc.length]).join(''); };
const hex = (buf) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
const hash = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
export const cleanCode = (s) => { s = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^STCK/, ''); return s.length === 5 && [...s].every((ch) => ABC.includes(ch)) ? s : null; };
const showCode = (c) => 'STCK-' + c;
export function cleanPlate(p) {
  p = p && typeof p === 'object' ? p : {};
  const name = String(p.name || '').normalize('NFC').replace(/[^\p{L}\p{N} '’.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'A friend';
  const key = (x) => (typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x) ? x : null);
  return { name, plate: PLATES.includes(p.plate) ? p.plate : 'cream', lv: Math.max(1, Math.min(99, Math.floor(+p.lv) || 1)), st: key(p.st), pin: key(p.pin) };
}
// what a friend alert says (cheers in the Friends screen's order)
const CHEERS = ['NICE ONE!', 'GAINS!', '✱ HIGH FIVE', 'PROUD!', 'YUM!', 'STICK WITH IT!'];
async function alert(env, them, msg) {
  if (!them || !them.push) return;
  let sub = null; try { sub = JSON.parse(them.push); } catch (e) { return; }
  const st = await push(env, sub, 'friend', Object.assign({ t: 'friend', url: 'Friends.html' }, msg)).catch(() => 0);
  if (st === 404 || st === 410) await env.DB.prepare('UPDATE users SET push = NULL WHERE id = ?').bind(them.id).run();
}
export function cleanSub(x, env) {   // env.TEST_PUSH_HTTP (local tests only) also allows http://127.0.0.1
  const okUrl = (u) => /^https:\/\//.test(u) || (!!(env && env.TEST_PUSH_HTTP) && /^http:\/\/127\.0\.0\.1:/.test(u));
  if (!x || typeof x !== 'object' || !okUrl(x.endpoint || '') || x.endpoint.length > 1000) return null;
  const k = x.keys || {}; if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 120 || k.auth.length > 40) return null;
  return JSON.stringify({ endpoint: x.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } });
}
const pub = (u) => u && { id: u.id, name: u.name, plate: u.plate, lv: u.lv, st: u.st, pin: u.pin };

export async function friends(path, b, env, out) {
  if (!env.DB) return out({ error: 'friends not set up' }, 503);
  await init(env);
  const secret = String(b.secret || '');
  if (secret.length < 32 || secret.length > 128) return out({ error: 'bad secret' }, 400);
  const key = await hash(secret), now = Date.now();
  let me = await env.DB.prepare('SELECT * FROM users WHERE key = ?').bind(key).first();
  if (path === '/f/me') {
    const p = cleanPlate(b.plate);
    if (!me) {
      for (let i = 0; i < 5 && !me; i++) {
        const id = rand(16, 'abcdefghijklmnopqrstuvwxyz0123456789'), code = rand(5);
        try { await env.DB.prepare('INSERT INTO users (id, key, code, name, plate, lv, st, pin, created, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, key, code, p.name, p.plate, p.lv, p.st, p.pin, now, now).run(); me = { id, code }; } catch (e) { /* code taken: try another */ }
      }
      if (!me) return out({ error: 'server' }, 500);
    } else await env.DB.prepare('UPDATE users SET name = ?, plate = ?, lv = ?, st = ?, pin = ?, seen = ? WHERE id = ?').bind(p.name, p.plate, p.lv, p.st, p.pin, now, me.id).run();
    return out({ ok: true, code: showCode(me.code) });
  }
  if (!me) return out({ error: 'not registered' }, 401);
  const linked = async (id) => !!(await env.DB.prepare('SELECT 1 FROM links WHERE a = ? AND b = ?').bind(me.id, id).first());
  const byCode = async () => { const c = cleanCode(b.code); return c ? env.DB.prepare('SELECT * FROM users WHERE code = ?').bind(c).first() : null; };
  const blockedEither = async (id) => !!(await env.DB.prepare('SELECT 1 FROM blocks WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(me.id, id, id, me.id).first());

  if (path === '/f/peek' || path === '/f/add') {
    const them = await byCode();
    if (!them || await blockedEither(them.id)) return out({ error: 'no such code' }, 404);   // a block looks the same as a wrong code
    if (them.id === me.id) return out({ error: 'self' }, 400);
    const already = await linked(them.id);
    if (path === '/f/peek') return out({ ok: true, friend: pub(them), already });
    if (!already) {
      const n = (await env.DB.prepare('SELECT COUNT(*) AS n FROM links WHERE a = ?').bind(me.id).first()).n;
      if (n >= MAX_FRIENDS) return out({ error: 'full' }, 400);
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO links (a, b, at) VALUES (?, ?, ?)').bind(me.id, them.id, now),
        env.DB.prepare('INSERT OR IGNORE INTO links (a, b, at) VALUES (?, ?, ?)').bind(them.id, me.id, now),
        env.DB.prepare('INSERT INTO events (dest, src, kind, c, at) VALUES (?, ?, ?, ?, ?)').bind(them.id, me.id, 'hello', null, now),
      ]);
      await alert(env, them, { title: me.name + ' added you as a friend', body: 'Say hi back with a cheer', tag: 'hello-' + me.id });
    }
    return out({ ok: true, friend: pub(them), already });
  }
  if (path === '/f/list') {
    await env.DB.prepare('UPDATE users SET seen = ? WHERE id = ?').bind(now, me.id).run();
    const fr = (await env.DB.prepare('SELECT u.id, u.name, u.plate, u.lv, u.st, u.pin, l.at AS since FROM links l JOIN users u ON u.id = l.b WHERE l.a = ? ORDER BY l.at DESC LIMIT ?').bind(me.id, MAX_FRIENDS).all()).results;
    const inbox = (await env.DB.prepare('SELECT e.id, e.src, e.kind, e.c, e.at FROM events e JOIN links l ON l.a = e.dest AND l.b = e.src WHERE e.dest = ? AND e.seen = 0 ORDER BY e.at LIMIT 20').bind(me.id).all()).results;
    return out({ ok: true, code: showCode(me.code), friends: fr, inbox });
  }
  if (path === '/f/push') { await env.DB.prepare('UPDATE users SET push = ? WHERE id = ?').bind(cleanSub(b.sub, env), me.id).run(); return out({ ok: true, on: !!cleanSub(b.sub, env) }); }
  if (path === '/f/seen') { await env.DB.prepare('UPDATE events SET seen = 1 WHERE id = ? AND dest = ?').bind(Math.floor(+b.id) || 0, me.id).run(); return out({ ok: true }); }
  const other = String(b.id || b.to || '').slice(0, 40);
  if (path === '/f/cheer') {
    const c = Math.floor(+b.c); if (!(c >= 0 && c < 20)) return out({ error: 'bad cheer' }, 400);
    if (!(await linked(other))) return out({ error: 'not friends' }, 404);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(CASE WHEN dest = ? THEN at END) AS last FROM events WHERE src = ? AND kind = ? AND at > ?').bind(other, me.id, 'cheer', now - 864e5).first();
    if (recent.n >= CHEERS_A_DAY || (recent.last && now - recent.last < CHEER_GAP)) return out({ error: 'slow down' }, 429);
    await env.DB.prepare('INSERT INTO events (dest, src, kind, c, at) VALUES (?, ?, ?, ?, ?)').bind(other, me.id, 'cheer', c, now).run();
    const them = await env.DB.prepare('SELECT id, push FROM users WHERE id = ?').bind(other).first();
    await alert(env, them, { title: me.name + ' sent you a cheer!', body: CHEERS[c] || 'Open Friends to see it', tag: 'cheer-' + me.id, image: 'icons/watch-sticker.png' });
    return out({ ok: true });
  }
  if (path === '/f/remove' || path === '/f/block') {
    const q = [env.DB.prepare('DELETE FROM links WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(me.id, other, other, me.id),
      env.DB.prepare('DELETE FROM events WHERE (dest = ? AND src = ?) OR (dest = ? AND src = ?)').bind(me.id, other, other, me.id)];
    if (path === '/f/block') q.push(env.DB.prepare('INSERT OR IGNORE INTO blocks (a, b) VALUES (?, ?)').bind(me.id, other));
    await env.DB.batch(q); return out({ ok: true });
  }
  return out({ error: 'not found' }, 404);
}

// tidy-up from the cron: seen cheers older than 30 days
export async function tidy(env) { if (!env.DB) return; await init(env); await env.DB.prepare('DELETE FROM events WHERE seen = 1 AND at < ?').bind(Date.now() - 30 * 864e5).run(); }
