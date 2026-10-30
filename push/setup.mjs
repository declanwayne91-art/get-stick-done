// Runs in the GitHub Action before deploying: makes sure the account has a workers.dev address and the KV store the
// worker keeps phones in, then writes wrangler.gen.toml (with the KV id) and url.txt (the worker's address, for the app).
import fs from 'node:fs';
const T = process.env.CLOUDFLARE_API_TOKEN, A = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!T || !A) { console.log('::error::Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID repository secrets'); process.exit(1); }
const api = async (method, path, body) => {
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + A + path, { method, headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); return j;
};
const first = await api('GET', '/workers/subdomain'); if (!first.success && (first.errors || []).some((e) => e.code === 10000 || e.code === 9109 || e.code === 6003)) { console.log('::error::Cloudflare rejected the token: ' + JSON.stringify(first.errors)); process.exit(1); }
let sub = first.result?.subdomain;
for (const name of ['getstickdone', 'getstickdone-app', 'get-stick-done-' + A.slice(0, 6)]) {
  if (sub) break;
  const j = await api('PUT', '/workers/subdomain', { subdomain: name }); if (j.success) sub = j.result?.subdomain || name;
  else console.log('::warning::subdomain ' + name + ' not available: ' + JSON.stringify(j.errors));
}
if (!sub) { console.log('::error::Could not set up a workers.dev subdomain'); process.exit(1); }
const TITLE = 'gsd-push-subs';
let ns = ((await api('GET', '/storage/kv/namespaces?per_page=100')).result || []).find((n) => n.title === TITLE);
if (!ns) { const j = await api('POST', '/storage/kv/namespaces', { title: TITLE }); if (!j.success) { console.log('::error::KV create failed ' + JSON.stringify(j.errors)); process.exit(1); } ns = j.result; }
const DBNAME = 'gsd-friends';   // friends: D1 database (the worker makes its own tables)
let db = ((await api('GET', '/d1/database?per_page=100')).result || []).find((d) => d.name === DBNAME);
if (!db) { const j = await api('POST', '/d1/database', { name: DBNAME }); if (!j.success) { console.log('::error::D1 create failed ' + JSON.stringify(j.errors)); process.exit(1); } db = j.result; }
fs.writeFileSync('push/wrangler.gen.toml', fs.readFileSync('push/wrangler.toml', 'utf8').replace('__KV_ID__', ns.id).replace('__D1_ID__', db.uuid || db.id));
fs.writeFileSync('push/url.txt', 'https://gsd-push.' + sub + '.workers.dev\n');
console.log('::notice::Nudge worker address: https://gsd-push.' + sub + '.workers.dev');
