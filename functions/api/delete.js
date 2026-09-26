// POST /api/delete  body: {"key": "ShareX/2026/09/abc.png"}
// Auth and same-origin checks happen in _middleware.js before this runs.

const MAX_KEY_LENGTH = 1024; // R2's own limit

export async function onRequestPost({ request, env }) {
  // Requiring JSON means a plain HTML form on another site can't produce a valid request.
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) {
    return new Response('Expected application/json', { status: 415 });
  }

  let key;
  try {
    ({ key } = await request.json());
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) {
    return new Response('Missing or invalid key', { status: 400 });
  }

  await env.BUCKET.delete(key);
  return Response.json({ deleted: key });
}
