// Runs in the GitHub Action before deploying: makes sure the account has a workers.dev address and the KV store the
// worker keeps phones in, then writes wrangler.gen.toml (with the KV id) and url.txt (the worker's address, for the app).
import fs from 'node:fs';
const T = process.env.CLOUDFLARE_API_TOKEN, A = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!T || !A) { console.error('Missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID repository secrets'); process.exit(1); }
const api = async (method, path, body) => {
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + A + path, { method, headers: { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); return j;
};
let sub = (await api('GET', '/workers/subdomain')).result?.subdomain;
for (const name of ['getstickdone', 'getstickdone-app', 'get-stick-done-' + A.slice(0, 6)]) {
  if (sub) break;
  const j = await api('PUT', '/workers/subdomain', { subdomain: name }); if (j.success) sub = j.result?.subdomain || name;
  else console.log('subdomain', name, 'not available:', JSON.stringify(j.errors));
}
if (!sub) { console.error('Could not set up a workers.dev subdomain'); process.exit(1); }
const TITLE = 'gsd-push-subs';
let ns = ((await api('GET', '/storage/kv/namespaces?per_page=100')).result || []).find((n) => n.title === TITLE);
if (!ns) { const j = await api('POST', '/storage/kv/namespaces', { title: TITLE }); if (!j.success) { console.error('KV create failed', JSON.stringify(j.errors)); process.exit(1); } ns = j.result; }
fs.writeFileSync('push/wrangler.gen.toml', fs.readFileSync('push/wrangler.toml', 'utf8').replace('__KV_ID__', ns.id));
fs.writeFileSync('push/url.txt', 'https://gsd-push.' + sub + '.workers.dev\n');
console.log('workers.dev subdomain:', sub, '| KV:', ns.id.slice(0, 6) + '…');
