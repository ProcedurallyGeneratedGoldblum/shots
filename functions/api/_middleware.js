// Guards every /api/* route.
//
// 1. Only requests that came through Cloudflare Access, carrying a valid signed Access
//    token for this application, get through. The token is verified cryptographically:
//    its mere presence is not trusted.
// 2. State-changing requests (anything other than GET/HEAD) must come from this site's
//    own origin, which blocks cross-site request forgery.
// 3. Every API response gets hardening headers.
//
// Needs two variables (wrangler.toml [vars] or the Pages dashboard):
//   ACCESS_TEAM_DOMAIN  e.g. https://yourteam.cloudflareaccess.com
//   ACCESS_AUD          the Application Audience (AUD) tag of your Access app
// For local testing only, set DEV_NO_AUTH=true in .dev.vars. It is ignored unless the
// request is to localhost, so it can't open up the deployed site by accident.

const JWKS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;
let jwks = null;

const b64url = s => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const json = bytes => JSON.parse(new TextDecoder().decode(bytes));
const trimSlash = s => String(s).replace(/\/+$/, '');

async function fetchKeys(team) {
  const r = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('could not fetch Access signing keys');
  jwks = { keys: (await r.json()).keys || [], expires: Date.now() + JWKS_TTL_MS };
  return jwks.keys;
}

async function keyFor(team, kid) {
  let keys = jwks && jwks.expires > Date.now() ? jwks.keys : await fetchKeys(team);
  let jwk = keys.find(k => k.kid === kid);
  // Access rotates its keys; on an unknown kid, refresh the cache once before giving up.
  if (!jwk) jwk = (await fetchKeys(team)).find(k => k.kid === kid);
  return jwk;
}

// Returns null if the token is valid, otherwise a short reason (safe to show: no secrets).
async function verify(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return 'token is not a JWT';
  const [h, p, s] = parts;
  const header = json(b64url(h));
  if (header.alg !== 'RS256') return 'unexpected token algorithm';

  const team = trimSlash(env.ACCESS_TEAM_DOMAIN);
  const jwk = await keyFor(team, header.kid);
  if (!jwk) return 'signing key not found at team domain (wrong ACCESS_TEAM_DOMAIN?)';
  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return 'bad signature';

  // Only read claims after the signature is proven.
  const payload = json(b64url(p));
  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return `AUD mismatch: token has ${aud.join(', ')}`;
  if (trimSlash(payload.iss) !== team) return `issuer mismatch: token has ${payload.iss}`;
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S <= now) return 'token expired';
  if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > now) return 'token not yet valid';
  return null;
}

function tokenFrom(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

function isLocal(url) {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
}

function deny(message, status = 403) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function harden(response) {
  const r = new Response(response.body, response);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Cache-Control', 'no-store');
  r.headers.set('Referrer-Policy', 'no-referrer');
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  return r;
}

async function guard({ request, env, next }) {
  const url = new URL(request.url);

  if (!['GET', 'HEAD'].includes(request.method)) {
    const origin = request.headers.get('Origin');
    if (origin !== url.origin) return deny('Forbidden: cross-origin request');
  }

  if (env.DEV_NO_AUTH === 'true' && isLocal(url)) return next();

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return deny('Access is not configured');
  const token = tokenFrom(request);
  if (!token) return deny('Forbidden: no Access token on the request');
  try {
    const problem = await verify(token, env);
    if (!problem) return next();
    return deny(`Forbidden: ${problem}`);
  } catch (e) {
    return deny('Auth check failed: malformed token or key fetch error');
  }
}

export async function onRequest(context) {
  return harden(await guard(context));
}
