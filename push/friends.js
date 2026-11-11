// Friends, on the same worker as the nudges. D1 (binding DB) keeps: who's who (an anonymous id, a hash of the phone's secret,
// the friend code and the name plate: name, plate colour, level, favourite sticker and pin), who's friends with whom, blocks,
// and cheers waiting to be seen. Shared lists (lists.js) keep the tasks you put on a shared list, and nothing else:
// your own list, meals, weights and water never leave the phone.
// Every route is POST JSON with { secret } (made on the phone, never stored here, only its SHA-256).
//   /f/me     { secret, plate }  -> { code }           register or update your name plate
//   /f/peek   { secret, code }   -> { friend }         whose code is this? (for the "add Dex?" card)
//   /f/add    { secret, code }   -> { friend }         become friends (both ways); they get a "hello"
//   /f/list   { secret }         -> { friends, inbox } your friends and cheers you haven't seen
//   /f/seen   { secret, id }                           you've seen that one
//   /f/cheer  { secret, to, c, about? }                send a cheer (c = which one; about = what it's for, 9 Nov 2026)
//   /f/now    { secret, now }                          what you're reading / playing / learning [{ h, t, by, k }] (9 Nov 2026)
//   /f/remove { secret, id }   /f/block { secret, id } (block = remove, and they can't add you again)
//   /f/delete { secret }                               delete my profile: name plate, code, friends, blocks, cheers, and my place on shared lists and plans
//   /f/push   { secret, sub }                          friend alerts: this phone's push subscription (null = off)
//   /f/meal   { secret, to: [ids], r, day, name, mid }  share one night's dinner (PLAN MY WEEK's paper plane); each friend gets a 'meal'
//   /f/mealre { secret, to, mid, re, day, name }        react to one: re 1 = YES CHEF!, 0 = NOT FOR ME; the sender gets a 'mealre'
//   /f/night  { secret, to: [ids], date, time, what, mid } invite friends to a game night (5 Nov 2026, the gaming page); each gets a 'night'
//   /f/nightre { secret, to, mid, re, date, time, what }  answer one: re 1 = I'M IN!, 0 = CAN'T MAKE IT; the host gets a 'nightre'
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
export const init = (env) => ready || (ready = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q)))
  .then(() => env.DB.prepare('ALTER TABLE users ADD COLUMN push TEXT').run().catch(() => {}))
  .then(() => env.DB.prepare('ALTER TABLE users ADD COLUMN n INTEGER').run().catch(() => {}))   // stickers stuck in total (shown on your friend card)
  .then(() => env.DB.prepare('ALTER TABLE users ADD COLUMN p INTEGER').run().catch(() => {}))
  .then(() => env.DB.prepare('ALTER TABLE events ADD COLUMN d TEXT').run().catch(() => {}))
  .then(() => env.DB.prepare('ALTER TABLE users ADD COLUMN nw TEXT').run().catch(() => {}))   // (9 Nov 2026) what you're reading / playing / learning: [{ h, t, by, k }]   // (3 Nov 2026) a shared meal's details: { r, day, name, mid }   // pins earned   // friend alerts: the phone's push address (added later; already there = fine)
  .catch((e) => { ready = null; throw e; }));

const ABC = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // no 0/O, 1/I/L
const PLATES = ['cream', 'lime', 'pink', 'sky', 'holo', 'sunset', 'gold', 'aurora', 'galaxy'];   // makeprofile.py PLATES (+ levelart.py)
const MAX_FRIENDS = 100, CHEERS_A_DAY = 60, CHEER_GAP = 30e3, MEALS_A_DAY = 40, NIGHTS_A_DAY = 40;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
// a shared meal, checked: recipe id, day of the week, the recipe's name (shown in the alert) and the sender's id for it
export function cleanMeal(b) {
  const r = typeof b.r === 'string' && /^[a-z0-9-]{1,48}$/.test(b.r) ? b.r : null, day = Math.floor(+b.day), mid = typeof b.mid === 'string' && /^[a-z0-9]{6,24}$/.test(b.mid) ? b.mid : null;
  const name = String(b.name || '').normalize('NFC').replace(/[^\p{L}\p{N} '’&,.()\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return r && mid && name && day >= 0 && day <= 6 ? { r, day, name, mid } : null;
}
// a game night, checked: the date (YYYY-MM-DD, today up to two weeks on), the time (HH:MM), what you're playing (optional) and the host's id for it
export function cleanNight(b) {
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : null, time = typeof b.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(b.time) ? b.time : null;
  const mid = typeof b.mid === 'string' && /^[a-z0-9]{6,24}$/.test(b.mid) ? b.mid : null;
  const what = String(b.what || '').normalize('NFC').replace(/[^\p{L}\p{N} '’&,.!?()\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const t = date ? Date.parse(date + 'T12:00:00Z') : NaN;
  return date && time && mid && isFinite(t) && t > Date.now() - 2 * 864e5 && t < Date.now() + 16 * 864e5 ? { date, time, what, mid } : null;
}
const nightWhen = (n) => { const d = new Date(n.date + 'T12:00:00Z'), [h, m] = n.time.split(':').map(Number);
  return DAYS[(d.getUTCDay() + 6) % 7] + ', ' + ((h + 11) % 12 + 1) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' am' : ' pm'); };
const rand = (n, abc = ABC) => { const b = crypto.getRandomValues(new Uint8Array(n)); return Array.from(b, (x) => abc[x % abc.length]).join(''); };
const hex = (buf) => Array.from(new Uint8Array(buf), (x) => x.toString(16).padStart(2, '0')).join('');
export const hash = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
export const cleanCode = (s) => { s = String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^STCK/, ''); return s.length === 5 && [...s].every((ch) => ABC.includes(ch)) ? s : null; };
const showCode = (c) => 'STCK-' + c;
// (9 Nov 2026) what you're into right now (your profile's plate and friends' cards): up to 3, one per hobby
const NOWH = ['read', 'game', 'music'];
const cleanText = (x, n) => String(x || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
export function cleanNow(a) {
  if (!Array.isArray(a)) return null; const out = [], seen = new Set();
  for (const x of a.slice(0, 3)) { if (!x || !NOWH.includes(x.h) || seen.has(x.h)) continue; const t = cleanText(x.t, 80); if (!t) continue; seen.add(x.h);
    out.push({ h: x.h, t, ...(cleanText(x.by, 60) ? { by: cleanText(x.by, 60) } : {}), ...(typeof x.k === 'string' && /^[a-z0-9_-]{1,24}$/.test(x.k) ? { k: x.k } : {}) }); }
  return out.length ? out : null;
}
export const cleanAbout = (x) => cleanText(x, 80) || null;
export function cleanPlate(p) {
  p = p && typeof p === 'object' ? p : {};
  const name = String(p.name || '').normalize('NFC').replace(/[^\p{L}\p{N} '’.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'A friend';
  const key = (x) => (typeof x === 'string' && /^[a-z0-9-]{1,32}$/.test(x) ? x : null);
  return { name, plate: PLATES.includes(p.plate) ? p.plate : 'cream', lv: Math.max(1, Math.min(99, Math.floor(+p.lv) || 1)), st: key(p.st), pin: key(p.pin) };
}
// what a friend alert says (cheers in the Friends screen's order)
const CHEERS = ['NICE ONE!', 'GAINS!', '✱ HIGH FIVE', 'PROUD!', 'YUM!', 'STICK WITH IT!'];
export async function alert(env, them, msg) {
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
const nowOf = (u) => { try { return u.nw ? JSON.parse(u.nw) : null; } catch (e) { return null; } };
export const pub = (u) => u && { id: u.id, name: u.name, plate: u.plate, lv: u.lv, st: u.st, pin: u.pin, n: u.n == null ? null : u.n, p: u.p == null ? null : u.p, now: nowOf(u) };

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
  if (path === '/f/now') { const n = cleanNow(b.now); await env.DB.prepare('UPDATE users SET nw = ?, seen = ? WHERE id = ?').bind(n ? JSON.stringify(n) : null, now, me.id).run(); return out({ ok: true }); }   // what you're into, for friends' cards
  if (path === '/f/n') {   // your sticker count (from the book) and pins (from your profile); either can be left out
    const c = (v) => v == null ? null : Math.max(0, Math.min(1000000, Math.floor(+v) || 0));
    await env.DB.prepare('UPDATE users SET n = COALESCE(?, n), p = COALESCE(?, p), seen = ? WHERE id = ?').bind(c(b.n), c(b.p), now, me.id).run(); return out({ ok: true }); }
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
    const fr = (await env.DB.prepare('SELECT u.id, u.name, u.plate, u.lv, u.st, u.pin, u.n, u.p, u.nw, l.at AS since FROM links l JOIN users u ON u.id = l.b WHERE l.a = ? ORDER BY l.at DESC LIMIT ?').bind(me.id, MAX_FRIENDS).all()).results;
    const inbox = (await env.DB.prepare('SELECT e.id, e.src, e.kind, e.c, e.d, e.at FROM events e JOIN links l ON l.a = e.dest AND l.b = e.src WHERE e.dest = ? AND e.seen = 0 ORDER BY e.at LIMIT 20').bind(me.id).all()).results;
    return out({ ok: true, code: showCode(me.code), friends: fr.map((u) => ({ ...u, nw: undefined, now: nowOf(u) })), inbox });
  }
  if (path === '/f/push') { await env.DB.prepare('UPDATE users SET push = ? WHERE id = ?').bind(cleanSub(b.sub, env), me.id).run(); return out({ ok: true, on: !!cleanSub(b.sub, env) }); }
  if (path === '/f/seen') { await env.DB.prepare('UPDATE events SET seen = 1 WHERE id = ? AND dest = ?').bind(Math.floor(+b.id) || 0, me.id).run(); return out({ ok: true }); }
  if (path === '/f/delete') {   // delete my friend profile: everything this server holds about me (11 Nov 2026)
    const D = env.DB, soft = async (f) => { try { await f(); } catch (e) { /* that table was never made: nothing to remove */ } };
    await soft(async () => {   // shared lists: leave each one (as /l/leave does); the last one out deletes the list
      for (const r of (await D.prepare('SELECT list FROM members WHERE user = ?').bind(me.id).all()).results) {
        await D.batch([D.prepare('DELETE FROM members WHERE list = ? AND user = ?').bind(r.list, me.id),
          D.prepare('UPDATE items SET for_id = NULL WHERE list = ? AND for_id = ?').bind(r.list, me.id), D.prepare('UPDATE items SET dibs = NULL WHERE list = ? AND dibs = ?').bind(r.list, me.id)]);
        if (!(await D.prepare('SELECT COUNT(*) AS n FROM members WHERE list = ?').bind(r.list).first()).n) await D.batch([D.prepare('DELETE FROM items WHERE list = ?').bind(r.list), D.prepare('DELETE FROM lists WHERE id = ?').bind(r.list)]);
      }
    });
    await soft(async () => {   // shared meal plans: leave each one (as /p/leave does), handing it on if it was mine
      for (const r of (await D.prepare('SELECT plan FROM plan_members WHERE user = ?').bind(me.id).all()).results) {
        await D.prepare('DELETE FROM plan_members WHERE plan = ? AND user = ?').bind(r.plan, me.id).run();
        const nx = await D.prepare('SELECT user FROM plan_members WHERE plan = ? ORDER BY at LIMIT 1').bind(r.plan).first();
        if (!nx) await D.prepare('DELETE FROM plans WHERE id = ?').bind(r.plan).run(); else await D.prepare('UPDATE plans SET owner = ? WHERE id = ? AND owner = ?').bind(nx.user, r.plan, me.id).run();
      }
    });
    await D.batch([D.prepare('DELETE FROM links WHERE a = ? OR b = ?').bind(me.id, me.id), D.prepare('DELETE FROM blocks WHERE a = ? OR b = ?').bind(me.id, me.id),
      D.prepare('DELETE FROM events WHERE dest = ? OR src = ?').bind(me.id, me.id), D.prepare('DELETE FROM users WHERE id = ?').bind(me.id)]);
    return out({ ok: true });
  }
  const other = String(b.id || b.to || '').slice(0, 40);
  if (path === '/f/cheer') {
    const c = Math.floor(+b.c); if (!(c >= 0 && c < 20)) return out({ error: 'bad cheer' }, 400);
    if (!(await linked(other))) return out({ error: 'not friends' }, 404);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(CASE WHEN dest = ? THEN at END) AS last FROM events WHERE src = ? AND kind = ? AND at > ?').bind(other, me.id, 'cheer', now - 864e5).first();
    if (recent.n >= CHEERS_A_DAY || (recent.last && now - recent.last < CHEER_GAP)) return out({ error: 'slow down' }, 429);
    const ab = cleanAbout(b.about);   // (9 Nov 2026) a cheer about what they're reading / playing / learning
    await env.DB.prepare('INSERT INTO events (dest, src, kind, c, d, at) VALUES (?, ?, ?, ?, ?, ?)').bind(other, me.id, 'cheer', c, ab ? JSON.stringify({ ab }) : null, now).run();
    const them = await env.DB.prepare('SELECT id, push FROM users WHERE id = ?').bind(other).first();
    await alert(env, them, { title: me.name + ' sent you a cheer!', body: (CHEERS[c] || 'Open Friends to see it') + (ab ? ' · about ' + ab : ''), tag: 'cheer-' + me.id, image: 'icons/watch-sticker.png' });
    return out({ ok: true });
  }
  if (path === '/f/meal') {   // one night's dinner, to one or more friends (only real friends get it)
    const m = cleanMeal(b); if (!m) return out({ error: 'bad meal' }, 400);
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).map((x) => String(x || '').slice(0, 40)))].slice(0, 20);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE src = ? AND kind = ? AND at > ?').bind(me.id, 'meal', now - 864e5).first();
    if (recent.n + to.length > MEALS_A_DAY) return out({ error: 'slow down' }, 429);
    let sent = 0;
    for (const id of to) {
      if (!(await linked(id))) continue;
      await env.DB.prepare('INSERT INTO events (dest, src, kind, c, d, at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, me.id, 'meal', null, JSON.stringify(m), now).run(); sent++;
      const them = await env.DB.prepare('SELECT id, push FROM users WHERE id = ?').bind(id).first();
      await alert(env, them, { title: me.name + ' shared ' + DAYS[m.day] + '’s dinner', body: m.name + ' · YES CHEF! or NOT FOR ME?', tag: 'meal-' + m.mid, url: 'PlanWeek.html' });
    }
    return sent ? out({ ok: true, sent }) : out({ error: 'not friends' }, 404);
  }
  if (path === '/f/mealre') {   // YES CHEF! (1) or NOT FOR ME (0), back to whoever shared it
    const m = cleanMeal(b), re = +b.re === 1 ? 1 : 0; if (!m) return out({ error: 'bad meal' }, 400);
    if (!(await linked(other))) return out({ error: 'not friends' }, 404);
    const sent = await env.DB.prepare('SELECT id FROM events WHERE dest = ? AND src = ? AND kind = ? AND d LIKE ?').bind(me.id, other, 'meal', '%"mid":"' + m.mid + '"%').first();
    if (!sent) return out({ error: 'no such meal' }, 404);   // you can only react to a meal you were sent
    await env.DB.prepare('DELETE FROM events WHERE dest = ? AND src = ? AND kind = ? AND seen = 0 AND d LIKE ?').bind(other, me.id, 'mealre', '%"mid":"' + m.mid + '"%').run();   // changed your mind: the newest one counts
    await env.DB.prepare('INSERT INTO events (dest, src, kind, c, d, at) VALUES (?, ?, ?, ?, ?, ?)').bind(other, me.id, 'mealre', re, JSON.stringify(m), now).run();
    const them = await env.DB.prepare('SELECT id, push FROM users WHERE id = ?').bind(other).first();
    await alert(env, them, { title: me.name + ': ' + (re ? 'YES CHEF!' : 'NOT FOR ME'), body: 'your ' + DAYS[m.day] + ' dinner, ' + m.name, tag: 'mealre-' + m.mid + '-' + me.id, url: 'PlanWeek.html' });
    return out({ ok: true });
  }
  if (path === '/f/night') {   // a game night, to one or more friends (only real friends get it)
    const n = cleanNight(b); if (!n) return out({ error: 'bad night' }, 400);
    const to = [...new Set((Array.isArray(b.to) ? b.to : []).map((x) => String(x || '').slice(0, 40)))].slice(0, 20);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE src = ? AND kind = ? AND at > ?').bind(me.id, 'night', now - 864e5).first();
    if (recent.n + to.length > NIGHTS_A_DAY) return out({ error: 'slow down' }, 429);
    let sent = 0;
    for (const id of to) {
      if (!(await linked(id))) continue;
      await env.DB.prepare('INSERT INTO events (dest, src, kind, c, d, at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, me.id, 'night', null, JSON.stringify(n), now).run(); sent++;
      const them = await env.DB.prepare('SELECT id, push FROM users WHERE id = ?').bind(id).first();
      await alert(env, them, { title: me.name + ' invited you to a game night', body: nightWhen(n) + (n.what ? ' · ' + n.what : '') + ' · I’M IN! or CAN’T MAKE IT?', tag: 'night-' + n.mid, url: 'Hobbies.html#game' });
    }
    return sent ? out({ ok: true, sent }) : out({ error: 'not friends' }, 404);
  }
  if (path === '/f/nightre') {   // I'M IN! (1) or CAN'T MAKE IT (0), back to the host
    const n = cleanNight(b), re = +b.re === 1 ? 1 : 0; if (!n) return out({ error: 'bad night' }, 400);
    if (!(await linked(other))) return out({ error: 'not friends' }, 404);
    const sent = await env.DB.prepare('SELECT id FROM events WHERE dest = ? AND src = ? AND kind = ? AND d LIKE ?').bind(me.id, other, 'night', '%"mid":"' + n.mid + '"%').first();
    if (!sent) return out({ error: 'no such night' }, 404);   // you can only answer a night you were invited to
    await env.DB.prepare('DELETE FROM events WHERE dest = ? AND src = ? AND kind = ? AND seen = 0 AND d LIKE ?').bind(other, me.id, 'nightre', '%"mid":"' + n.mid + '"%').run();   // changed your mind: the newest one counts
    await env.DB.prepare('INSERT INTO events (dest, src, kind, c, d, at) VALUES (?, ?, ?, ?, ?, ?)').bind(other, me.id, 'nightre', re, JSON.stringify(n), now).run();
    const them = await env.DB.prepare('SELECT id, push FROM users WHERE id = ?').bind(other).first();
    await alert(env, them, { title: me.name + ': ' + (re ? 'I’M IN!' : 'CAN’T MAKE IT'), body: 'your game night, ' + nightWhen(n), tag: 'nightre-' + n.mid + '-' + me.id, url: 'Hobbies.html#game' });
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
