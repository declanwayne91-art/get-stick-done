// Web Push sending, shared by the water nudges (worker.js) and friends (friends.js).
// - VAPID: signing keys made by the worker the first time and kept in KV (GET /key hands out the public half).
// - push(env, sub, topic, payload?): no payload = a bare "wake up" (water nudges: the app's service worker writes the words);
//   with a payload (an object) it's encrypted for that phone (RFC 8291, aes128gcm) so the notification can say who and what.
// Returns the push service's status (404 / 410 = that phone has gone: forget it).

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); const r = atob(s + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
const utf8 = (s) => new TextEncoder().encode(s);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
export { b64u, unb64u, utf8 };

export async function vapid(env) {
  let v = await env.SUBS.get('vapid', 'json');
  if (!v) {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u(await crypto.subtle.exportKey('raw', k.publicKey)), jwk: await crypto.subtle.exportKey('jwk', k.privateKey) };
    await env.SUBS.put('vapid', JSON.stringify(v));
  }
  return v;
}

const CONTACT = 'https://declanwayne91-art.github.io/get-stick-done/';
async function jwt(v, aud) {
  const head = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(utf8(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT })));
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(head + '.' + body));   // raw r||s, as JWT wants
  return head + '.' + body + '.' + b64u(sig);
}

const hkdf = async (salt, ikm, info, bytes) => new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info },
  await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), bytes * 8));

// RFC 8291 message encryption (aes128gcm, one record). `fixed` lets the test pass a known server key pair and salt.
export async function encrypt(sub, plaintext, fixed) {
  const ua = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  if (ua.length !== 65 || auth.length !== 16) throw new Error('bad subscription keys');
  const as = fixed ? fixed.pair : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', ua, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, cat(utf8('WebPush: info\0'), ua, asPub), 32);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(plaintext, new Uint8Array([2]))));   // 0x02: last record
  const rs = new Uint8Array([0, 0, 16, 0]);   // record size 4096
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

export async function push(env, sub, topic = 'water', payload = null) {
  const v = await vapid(env), url = new URL(sub.endpoint);
  const headers = { Authorization: 'vapid t=' + await jwt(v, url.origin) + ', k=' + v.pub, TTL: payload ? '86400' : '1800', Urgency: 'normal', Topic: topic };
  let body = null;
  if (payload) { body = await encrypt(sub, utf8(JSON.stringify(payload))); headers['Content-Encoding'] = 'aes128gcm'; headers['Content-Type'] = 'application/octet-stream'; }
  else headers['Content-Length'] = '0';
  const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
  return res.status;
}
