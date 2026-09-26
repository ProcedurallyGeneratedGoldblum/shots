// POST /api/upload?mode=copy|replace&source=<key>
// Body: the raw image bytes, with Content-Type image/png, image/jpeg or image/webp.
//
//   mode=copy     saves next to the source under a new random name and returns its key
//   mode=replace  overwrites the source (same key, so existing links show the new image)
//
// Auth and the same-origin check happen in _middleware.js before this runs.

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_KEY_LENGTH = 1024;
const TYPES = {
  'image/png': { ext: 'png', matches: ['png'] },
  'image/jpeg': { ext: 'jpg', matches: ['jpg', 'jpeg'] },
  'image/webp': { ext: 'webp', matches: ['webp'] },
};
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const bad = (message, status = 400) => new Response(message, { status });
const extOf = key => (key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

// Check the file really is what its Content-Type claims, by its first bytes.
function looksLike(type, b) {
  if (type === 'image/png') {
    return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  }
  if (type === 'image/jpeg') return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/webp') {
    const tag = s => String.fromCharCode(...s);
    return b.length > 12 && tag(b.slice(0, 4)) === 'RIFF' && tag(b.slice(8, 12)) === 'WEBP';
  }
  return false;
}

function randomName(length = 12) {
  const out = [];
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(bytes);
    for (const x of bytes) {
      if (x < 248 && out.length < length) out.push(ALPHABET[x % 62]); // 248 = 4*62, no modulo bias
    }
  }
  return out.join('');
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode');
  const source = url.searchParams.get('source');
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();

  if (mode !== 'copy' && mode !== 'replace') return bad('mode must be copy or replace');
  if (!source || source.length > MAX_KEY_LENGTH) return bad('Missing or invalid source');
  if (!TYPES[type]) return bad('Only PNG, JPEG or WebP images can be uploaded', 415);

  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BYTES) return bad('Image too large', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return bad('Empty body');
  if (bytes.length > MAX_BYTES) return bad('Image too large', 413);
  if (!looksLike(type, bytes)) return bad('File content does not match its type', 415);

  // Only images that already exist in the bucket can be annotated.
  const original = await env.BUCKET.head(source);
  if (!original) return bad('Source not found', 404);

  let key;
  if (mode === 'replace') {
    // Keep the extension honest: a .png link must keep serving a PNG.
    if (!TYPES[type].matches.includes(extOf(source))) {
      return bad('Replacing needs the same image type as the original', 415);
    }
    key = source;
  } else {
    const dir = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : '';
    for (let i = 0; i < 5 && !key; i++) {
      const candidate = `${dir}${randomName()}.${TYPES[type].ext}`;
      if (!(await env.BUCKET.head(candidate))) key = candidate;
    }
    if (!key) return bad('Could not pick a free name, try again', 500);
  }

  const saved = await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: type } });
  return Response.json({ key, size: saved.size, uploaded: saved.uploaded.toISOString(), mode });
}
