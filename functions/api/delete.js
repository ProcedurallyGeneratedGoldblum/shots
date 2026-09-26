// POST /api/delete  body: {"key": "ShareX/2026/09/abc.png"}

export async function onRequestPost({ request, env }) {
  let key;
  try {
    ({ key } = await request.json());
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  if (typeof key !== 'string' || !key || key.length > 1024) {
    return new Response('Missing key', { status: 400 });
  }
  await env.BUCKET.delete(key);
  return Response.json({ deleted: key });
}
