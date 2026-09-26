// GET /api/list[?cursor=...]
// Returns up to ~5,000 newest-first objects per call, plus a cursor if there are more.
// Auth happens in _middleware.js before this runs.

const PAGES_PER_CALL = 5; // R2 returns at most 1,000 keys per list() call
const MAX_CURSOR_LENGTH = 2048;

export async function onRequestGet({ request, env }) {
  let cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  if (cursor && cursor.length > MAX_CURSOR_LENGTH) {
    return new Response('Invalid cursor', { status: 400 });
  }

  const objects = [];
  try {
    for (let i = 0; i < PAGES_PER_CALL; i++) {
      const page = await env.BUCKET.list({ cursor, limit: 1000 });
      for (const o of page.objects) {
        objects.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
      }
      cursor = page.truncated ? page.cursor : undefined;
      if (!cursor) break;
    }
  } catch {
    return new Response('Could not list the bucket (bad cursor?)', { status: 400 });
  }

  objects.sort((a, b) => b.uploaded.localeCompare(a.uploaded));

  return Response.json({
    base: String(env.PUBLIC_BASE || '').replace(/\/+$/, ''),
    objects,
    cursor: cursor || null,
  });
}
