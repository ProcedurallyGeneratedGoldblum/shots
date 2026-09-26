// Security tests for the API. Run with:  npm test   (Node 20+, no dependencies)
//
// A throwaway RSA key pair stands in for Cloudflare Access: we publish its public half as
// the "certs" endpoint (by stubbing fetch) and sign tokens with the private half.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { onRequest as middleware } from '../functions/api/_middleware.js';
import { onRequestPost as del } from '../functions/api/delete.js';
import { onRequestGet as list } from '../functions/api/list.js';

const TEAM = 'https://example.cloudflareaccess.com';
const AUD = 'test-aud-123';
const SITE = 'https://shots.example.pages.dev';

const good = generateKeyPairSync('rsa', { modulusLength: 2048 });
const evil = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...good.publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };

globalThis.fetch = async url => {
  assert.equal(String(url), `${TEAM}/cdn-cgi/access/certs`);
  return new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } });
};

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
function sign(claims, { key = good.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const h = b64({ alg, kid, typ: 'JWT' });
  const p = b64({ aud: [AUD], iss: TEAM, exp: now() + 3600, iat: now(), ...claims });
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url');
  return `${h}.${p}.${s}`;
}

const env = (extra = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra });
let reachedHandler;
beforeEach(() => { reachedHandler = false; });
const next = async () => { reachedHandler = true; return new Response('ok'); };

function run({ token, cookie, method = 'GET', origin, url = `${SITE}/api/list`, e = env() } = {}) {
  const headers = new Headers();
  if (token) headers.set('Cf-Access-Jwt-Assertion', token);
  if (cookie) headers.set('Cookie', cookie);
  if (origin) headers.set('Origin', origin);
  return middleware({ request: new Request(url, { method, headers }), env: e, next });
}

// ---- Authentication ------------------------------------------------------------

test('valid token in header is allowed', async () => {
  const r = await run({ token: sign({}) });
  assert.equal(r.status, 200);
  assert.ok(reachedHandler);
});

test('valid token in CF_Authorization cookie is allowed', async () => {
  const r = await run({ cookie: `other=1; CF_Authorization=${sign({})}` });
  assert.equal(r.status, 200);
});

const rejected = {
  'no token': {},
  'garbage token': { token: 'not.a.jwt' },
  'two-part token': { token: 'abc.def' },
  'token signed by an unknown key': { token: sign({}, { key: evil.privateKey }) },
  'token with an unknown kid': { token: sign({}, { kid: 'nope' }) },
  'alg=none token': { token: sign({}, { alg: 'none' }) },
  'HS256 token': { token: sign({}, { alg: 'HS256' }) },
  'wrong audience': { token: sign({ aud: ['someone-else'] }) },
  'wrong issuer': { token: sign({ iss: 'https://evil.cloudflareaccess.com' }) },
  'expired token': { token: sign({ exp: now() - 3600 }) },
  'token without exp': { token: sign({ exp: undefined }) },
  'token not yet valid': { token: sign({ nbf: now() + 3600 }) },
};
for (const [name, opts] of Object.entries(rejected)) {
  test(`rejects: ${name}`, async () => {
    const r = await run(opts);
    assert.equal(r.status, 403);
    assert.equal(reachedHandler, false);
  });
}

test('tampered payload (valid signature from another token) is rejected', async () => {
  const [h, , s] = sign({}).split('.');
  const forged = `${h}.${b64({ aud: [AUD], iss: TEAM, exp: now() + 9999, email: 'attacker@x' })}.${s}`;
  const r = await run({ token: forged });
  assert.equal(r.status, 403);
});

test('fails closed when Access is not configured', async () => {
  const r = await run({ token: sign({}), e: {} });
  assert.equal(r.status, 403);
  assert.equal(reachedHandler, false);
});

// ---- Dev bypass ----------------------------------------------------------------

test('DEV_NO_AUTH is ignored on the deployed site', async () => {
  const r = await run({ e: env({ DEV_NO_AUTH: 'true' }) });
  assert.equal(r.status, 403);
});

test('DEV_NO_AUTH works on localhost', async () => {
  const r = await run({ url: 'http://localhost:8788/api/list', e: env({ DEV_NO_AUTH: 'true' }) });
  assert.equal(r.status, 200);
});

// ---- CSRF ----------------------------------------------------------------------

test('POST from the site itself is allowed', async () => {
  const r = await run({ token: sign({}), method: 'POST', origin: SITE, url: `${SITE}/api/delete` });
  assert.equal(r.status, 200);
});

test('POST from another origin is blocked, even with a valid token', async () => {
  const r = await run({ token: sign({}), method: 'POST', origin: 'https://evil.example', url: `${SITE}/api/delete` });
  assert.equal(r.status, 403);
  assert.equal(reachedHandler, false);
});

test('POST without an Origin header is blocked', async () => {
  const r = await run({ token: sign({}), method: 'POST', url: `${SITE}/api/delete` });
  assert.equal(r.status, 403);
});

// ---- Response hardening --------------------------------------------------------

test('API responses carry hardening headers, including on errors', async () => {
  for (const r of [await run({ token: sign({}) }), await run({})]) {
    assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
  }
});

// ---- Handlers ------------------------------------------------------------------

function fakeBucket(keys = []) {
  const deleted = [];
  return {
    deleted,
    async delete(k) { deleted.push(k); },
    async list() {
      return { truncated: false, objects: keys.map(k => ({ key: k, size: 1, uploaded: new Date() })) };
    },
  };
}

test('delete rejects non-JSON bodies (form-style CSRF)', async () => {
  const BUCKET = fakeBucket();
  const request = new Request(`${SITE}/api/delete`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"key":"a.png"}',
  });
  const r = await del({ request, env: { BUCKET } });
  assert.equal(r.status, 415);
  assert.deepEqual(BUCKET.deleted, []);
});

test('delete validates the key', async () => {
  for (const body of ['{}', '{"key":""}', '{"key":123}', `{"key":"${'x'.repeat(2000)}"}`, 'not json']) {
    const BUCKET = fakeBucket();
    const request = new Request(`${SITE}/api/delete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const r = await del({ request, env: { BUCKET } });
    assert.equal(r.status, 400, body);
    assert.deepEqual(BUCKET.deleted, []);
  }
});

test('delete removes exactly the requested key', async () => {
  const BUCKET = fakeBucket();
  const request = new Request(`${SITE}/api/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"key":"ShareX/a.png"}',
  });
  const r = await del({ request, env: { BUCKET } });
  assert.equal(r.status, 200);
  assert.deepEqual(BUCKET.deleted, ['ShareX/a.png']);
});

test('list rejects oversized cursors', async () => {
  const request = new Request(`${SITE}/api/list?cursor=${'x'.repeat(5000)}`);
  const r = await list({ request, env: { BUCKET: fakeBucket(), PUBLIC_BASE: 'https://img' } });
  assert.equal(r.status, 400);
});

test('list returns objects and the public base', async () => {
  const request = new Request(`${SITE}/api/list`);
  const r = await list({ request, env: { BUCKET: fakeBucket(['a.png', 'b.png']), PUBLIC_BASE: 'https://img/' } });
  const body = await r.json();
  assert.equal(body.base, 'https://img');
  assert.equal(body.objects.length, 2);
  assert.equal(body.cursor, null);
});

// ---- Annotation: upload and raw ------------------------------------------------

import { onRequestPost as upload } from '../functions/api/upload.js';
import { onRequestGet as raw } from '../functions/api/raw.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);

function storeBucket(initial = {}) {
  const files = new Map(Object.entries(initial).map(([k, v]) => [k, { bytes: v.bytes, type: v.type }]));
  return {
    files,
    async head(k) { return files.has(k) ? { key: k } : null; },
    async get(k) {
      const f = files.get(k);
      if (!f) return null;
      return {
        body: f.bytes, httpEtag: '"e"',
        writeHttpMetadata(h) { h.set('Content-Type', f.type); },
      };
    },
    async put(k, bytes, opts) {
      files.set(k, { bytes, type: opts.httpMetadata.contentType });
      return { size: bytes.length, uploaded: new Date() };
    },
  };
}

function up(query, { type = 'image/png', body = PNG } = {}) {
  return new Request(`${SITE}/api/upload?${query}`, { method: 'POST', headers: { 'Content-Type': type }, body });
}

test('upload copy: saves a new random key next to the source, original untouched', async () => {
  const BUCKET = storeBucket({ 'ShareX/2026/09/orig.png': { bytes: PNG, type: 'image/png' } });
  const r = await upload({ request: up('mode=copy&source=ShareX/2026/09/orig.png'), env: { BUCKET } });
  assert.equal(r.status, 200);
  const { key } = await r.json();
  assert.match(key, /^ShareX\/2026\/09\/[A-Za-z0-9]{12}\.png$/);
  assert.equal(BUCKET.files.size, 2);
  assert.equal(BUCKET.files.get(key).type, 'image/png');
});

test('upload copy of a JPEG gets a .jpg name', async () => {
  const BUCKET = storeBucket({ 'a.jpg': { bytes: JPG, type: 'image/jpeg' } });
  const r = await upload({ request: up('mode=copy&source=a.jpg', { type: 'image/jpeg', body: JPG }), env: { BUCKET } });
  assert.match((await r.json()).key, /^[A-Za-z0-9]{12}\.jpg$/);
});

test('upload replace: overwrites the same key', async () => {
  const BUCKET = storeBucket({ 'x/orig.png': { bytes: new Uint8Array([1]), type: 'image/png' } });
  const r = await upload({ request: up('mode=replace&source=x/orig.png'), env: { BUCKET } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).key, 'x/orig.png');
  assert.deepEqual([...BUCKET.files.get('x/orig.png').bytes], [...PNG]);
});

const badUploads = {
  'unknown mode': [up('mode=nuke&source=a.png'), 400],
  'missing source': [up('mode=copy'), 400],
  'source that does not exist': [up('mode=copy&source=nope.png'), 404],
  'non-image type': [up('mode=copy&source=a.png', { type: 'text/html', body: new TextEncoder().encode('<script>') }), 415],
  'SVG (can carry scripts)': [up('mode=copy&source=a.png', { type: 'image/svg+xml', body: new TextEncoder().encode('<svg/>') }), 415],
  'HTML disguised as PNG': [up('mode=copy&source=a.png', { body: new TextEncoder().encode('<html><script>alert(1)</script>') }), 415],
  'empty body': [up('mode=copy&source=a.png', { body: new Uint8Array() }), 400],
  'replace with a different type': [up('mode=replace&source=a.png', { type: 'image/jpeg', body: JPG }), 415],
};
for (const [name, [request, status]] of Object.entries(badUploads)) {
  test(`upload rejects: ${name}`, async () => {
    const BUCKET = storeBucket({ 'a.png': { bytes: PNG, type: 'image/png' } });
    const before = [...BUCKET.files.keys()];
    const r = await upload({ request, env: { BUCKET } });
    assert.equal(r.status, status);
    assert.deepEqual([...BUCKET.files.keys()], before);
    assert.equal(BUCKET.files.get('a.png').bytes, PNG);
  });
}

test('upload rejects oversized bodies', async () => {
  const BUCKET = storeBucket({ 'a.png': { bytes: PNG, type: 'image/png' } });
  const big = new Uint8Array(26 * 1024 * 1024); big.set(PNG);
  const r = await upload({ request: up('mode=copy&source=a.png', { body: big }), env: { BUCKET } });
  assert.equal(r.status, 413);
  assert.equal(BUCKET.files.size, 1);
});

test('upload from another origin is blocked by the middleware', async () => {
  const r = await run({ token: sign({}), method: 'POST', origin: 'https://evil.example', url: `${SITE}/api/upload?mode=copy&source=a.png` });
  assert.equal(r.status, 403);
  assert.equal(reachedHandler, false);
});

test('raw returns the file with sandboxing headers', async () => {
  const BUCKET = storeBucket({ 'a.png': { bytes: PNG, type: 'image/png' } });
  const r = await raw({ request: new Request(`${SITE}/api/raw?key=a.png`), env: { BUCKET } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('Content-Type'), 'image/png');
  assert.equal(r.headers.get('Content-Disposition'), 'attachment');
  assert.match(r.headers.get('Content-Security-Policy'), /sandbox/);
});

test('raw: missing key 400, unknown key 404', async () => {
  const BUCKET = storeBucket();
  assert.equal((await raw({ request: new Request(`${SITE}/api/raw`), env: { BUCKET } })).status, 400);
  assert.equal((await raw({ request: new Request(`${SITE}/api/raw?key=zz.png`), env: { BUCKET } })).status, 404);
});
