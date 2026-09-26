// GET /api/list[?cursor=...]
// Returns up to ~5,000 newest-first objects per call, plus a cursor if there are more.

const PAGES_PER_CALL = 5; // R2 returns at most 1,000 keys per list() call

export async function onRequestGet({ request, env }) {
  let cursor = new URL(request.url).searchParams.get('cursor') || undefined;
  const objects = [];

  for (let i = 0; i < PAGES_PER_CALL; i++) {
    const page = await env.BUCKET.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      objects.push({ key: o.key, size: o.size, uploaded: o.uploaded.toISOString() });
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (!cursor) break;
  }

  objects.sort((a, b) => b.uploaded.localeCompare(a.uploaded));

  return Response.json(
    { base: env.PUBLIC_BASE.replace(/\/$/, ''), objects, cursor: cursor || null },
    { headers: { 'Cache-Control': 'no-store' } });
}
