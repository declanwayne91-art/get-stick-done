// MOVE TO A NEW PHONE (10 Nov 2026): carry everything from one phone to another with a code, no account.
// The old phone scrambles (encrypts) its data with a key made from the code, and leaves it here for up to 10 minutes under
// an id also made from the code. The code never comes here, so this server can't read what it holds. The new phone, given
// the code (QR or typed), fetches it, unscrambles it, saves it, then says "done"; the old phone sees that and clears itself.
// D1 (binding DB): mv (one row per move: state 'w' waiting / 'd' done) and mv_part (the data, in pieces under D1's 2 MB cap).
// Every route is POST JSON with { id } (64 hex):
//   /m/put   { id, data }   leave it (replaces an earlier try)      -> { ok }
//   /m/get   { id }         fetch it (as often as needed until done) -> { ok, data } | 404
//   /m/done  { id }         the new phone has it: drop the data      -> { ok }
//   /m/state { id }         for the old phone: 'w' | 'd' | 'x' (gone or never there)
//   /m/drop  { id }         the old phone changed its mind
// The data goes after 10 minutes; a 'done' mark is kept 7 days so an old phone that was put away still finds out.
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS mv (id TEXT PRIMARY KEY, st TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS mv_part (id TEXT NOT NULL, i INTEGER NOT NULL, d TEXT NOT NULL, PRIMARY KEY (id, i))',
];
let ready = null;
const init = (env) => ready || (ready = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { ready = null; throw e; }));
export const LIFE = 10 * 60000, KEEP_DONE = 7 * 864e5, MAX = 8000000, PIECE = 900000;
const drop = (env, id) => env.DB.batch([env.DB.prepare('DELETE FROM mv_part WHERE id = ?').bind(id), env.DB.prepare('DELETE FROM mv WHERE id = ?').bind(id)]);

export async function moves(path, b, env, out) {
  if (!env.DB) return out({ error: 'no database' }, 503);
  const id = String(b.id || ''); if (!/^[0-9a-f]{64}$/.test(id)) return out({ error: 'bad id' }, 400);
  await init(env);
  const now = Date.now();
  let row = await env.DB.prepare('SELECT st, n, at FROM mv WHERE id = ?').bind(id).first();
  if (row && row.st === 'w' && now - row.at > LIFE) { await drop(env, id); row = null; }   // ran out
  if (path === '/m/put') {
    const data = typeof b.data === 'string' ? b.data : ''; if (!data || !/^[A-Za-z0-9+/=]+$/.test(data.slice(0, 2000))) return out({ error: 'bad data' }, 400);
    if (data.length > MAX) return out({ error: 'too big' }, 413);
    if (row && row.st === 'd') return out({ error: 'used' }, 409);
    await drop(env, id);
    const n = Math.ceil(data.length / PIECE);
    for (let i = 0; i < n; i++) await env.DB.prepare('INSERT INTO mv_part (id, i, d) VALUES (?, ?, ?)').bind(id, i, data.slice(i * PIECE, (i + 1) * PIECE)).run();
    await env.DB.prepare('INSERT INTO mv (id, st, n, at) VALUES (?, ?, ?, ?)').bind(id, 'w', n, now).run();
    return out({ ok: true, life: LIFE });
  }
  if (path === '/m/state') return out({ ok: true, state: row ? row.st : 'x' });
  if (path === '/m/drop') { if (row && row.st === 'w') await drop(env, id); return out({ ok: true }); }
  if (path === '/m/get') {
    if (!row || row.st !== 'w') return out({ error: row ? 'used' : 'not found' }, row ? 409 : 404);
    const parts = (await env.DB.prepare('SELECT d FROM mv_part WHERE id = ? ORDER BY i').bind(id).all()).results || [];
    if (parts.length !== row.n) return out({ error: 'not found' }, 404);
    return out({ ok: true, data: parts.map((p) => p.d).join('') });
  }
  if (path === '/m/done') {
    if (!row) return out({ error: 'not found' }, 404);
    await env.DB.batch([env.DB.prepare('DELETE FROM mv_part WHERE id = ?').bind(id), env.DB.prepare('UPDATE mv SET st = ?, n = 0, at = ? WHERE id = ?').bind('d', now, id)]);
    return out({ ok: true });
  }
  return out({ error: 'not found' }, 404);
}
// nightly: anything that ran out, and 'done' marks older than a week
export async function tidyMoves(env) {
  if (!env.DB) return; await init(env); const now = Date.now();
  await env.DB.prepare('DELETE FROM mv_part WHERE id IN (SELECT id FROM mv WHERE st = ? AND at < ?)').bind('w', now - LIFE).run();
  await env.DB.prepare('DELETE FROM mv WHERE (st = ? AND at < ?) OR (st = ? AND at < ?)').bind('w', now - LIFE, 'd', now - KEEP_DONE).run();
}
