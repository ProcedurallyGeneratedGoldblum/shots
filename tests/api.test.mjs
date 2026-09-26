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
