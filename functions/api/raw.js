// GET /api/raw?key=...
// Streams an object from the bucket through this site's own origin, so the annotation
// editor can draw it on a canvas and export it (a cross-origin r2.dev image would
// "taint" the canvas and block export). Auth happens in _middleware.js.

const MAX_KEY_LENGTH = 1024;

export async function onRequestGet({ request, env }) {
  const key = new URL(request.url).searchParams.get('key');
  if (!key || key.length > MAX_KEY_LENGTH) {
    return new Response('Missing or invalid key', { status: 400 });
  }

  const object = await env.BUCKET.get(key);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  // Never let a stored file render as a page on this origin, whatever its type.
  headers.set('Content-Disposition', 'attachment');
  headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
  return new Response(object.body, { headers });
}
