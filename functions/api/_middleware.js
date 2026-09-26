// Guards every /api/* route. Only requests that came through Cloudflare Access
// (with a valid, signed Access token for this app) get through.
//
// Needs two variables (wrangler.toml [vars] or the Pages dashboard):
//   ACCESS_TEAM_DOMAIN  e.g. https://yourteam.cloudflareaccess.com
//   ACCESS_AUD          the Application Audience (AUD) tag of your Access app
// For local testing only, set DEV_NO_AUTH=true in .dev.vars to skip the check.

let jwks = null;

const b64url = s => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const json = bytes => JSON.parse(new TextDecoder().decode(bytes));

async function keys(team) {
  if (!jwks || jwks.expires < Date.now()) {
    const r = await fetch(`${team}/cdn-cgi/access/certs`);
    if (!r.ok) throw new Error('Could not fetch Access certs');
    jwks = { keys: (await r.json()).keys, expires: Date.now() + 3600_000 };
  }
  return jwks.keys;
}

async function verify(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [h, p, s] = parts;
  const header = json(b64url(h));
  const payload = json(b64url(p));

  const jwk = (await keys(env.ACCESS_TEAM_DOMAIN)).find(k => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) return false;

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return aud.includes(env.ACCESS_AUD)
    && payload.iss === env.ACCESS_TEAM_DOMAIN
    && payload.exp * 1000 > Date.now();
}

function tokenFrom(request) {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header;
  const m = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

export async function onRequest({ request, env, next }) {
  if (env.DEV_NO_AUTH === 'true') return next();
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return new Response('Access is not configured', { status: 403 });
  }
  const token = tokenFrom(request);
  try {
    if (token && await verify(token, env)) return next();
  } catch (e) {
    return new Response('Auth check failed', { status: 403 });
  }
  return new Response('Forbidden', { status: 403 });
}
