// Cloudflare Worker for the Hooptober tracker.
// - /3/...  : TMDb proxy (needs the TMDB_KEY secret)
// - /sync   : saves/loads a tracker list by sync code (needs a KV binding named SYNC)
// Paste this whole file into the Worker's code editor and deploy.

const ALLOWED_ORIGINS = ['https://bramdraper.github.io'];
const SYNC_CODE_PATTERN = /^HOOP-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const MAX_SYNC_BYTES = 512 * 1024;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const originAllowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originAllowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Sync-Code',
      'Vary': 'Origin'
    };
    const json = (body, status = 200, extra = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json', ...extra }
      });

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // ---------- Sync ----------
    if (url.pathname === '/sync') {
      if (!originAllowed) return json({ error: 'Origin not allowed' }, 403);
      if (!env.SYNC) return json({ error: 'Sync storage is not set up' }, 500);

      const code = (request.headers.get('X-Sync-Code') || '').trim().toUpperCase();
      if (!SYNC_CODE_PATTERN.test(code)) return json({ error: 'Invalid sync code' }, 400);
      const storageKey = 'v1:' + (await sha256Hex(code));
      const noStore = { 'Cache-Control': 'no-store' };

      if (request.method === 'GET') {
        const stored = await env.SYNC.get(storageKey);
        if (!stored) return json({ error: 'Not found' }, 404, noStore);
        return new Response(stored, {
          headers: { ...cors, ...noStore, 'Content-Type': 'application/json' }
        });
      }

      if (request.method === 'PUT') {
        const text = await request.text();
        if (text.length > MAX_SYNC_BYTES) return json({ error: 'List is too large' }, 413);
        let body;
        try { body = JSON.parse(text); } catch (e) { return json({ error: 'Bad JSON' }, 400); }
        if (!body || typeof body.data !== 'object' || !Array.isArray(body.data.slots)) {
          return json({ error: 'Bad data' }, 400);
        }

        const existingText = await env.SYNC.get(storageKey);
        const existing = existingText ? JSON.parse(existingText) : null;
        const base = body.baseUpdatedAt ?? null;
        if (existing && !body.force && existing.updatedAt !== base) {
          return json({ error: 'Conflict', updatedAt: existing.updatedAt }, 409, noStore);
        }

        const updatedAt = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);
        await env.SYNC.put(storageKey, JSON.stringify({ updatedAt, data: body.data }));
        return json({ updatedAt }, 200, noStore);
      }

      return json({ error: 'Method not allowed' }, 405);
    }

    // ---------- TMDb proxy ----------
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    if (!/^\/3\/(search\/movie|movie\/\d+)$/.test(url.pathname)) {
      return new Response('Not found', { status: 404, headers: cors });
    }

    const target = new URL('https://api.themoviedb.org' + url.pathname);
    url.searchParams.forEach((v, k) => { if (k !== 'api_key') target.searchParams.set(k, v); });
    target.searchParams.set('api_key', env.TMDB_KEY);

    const res = await fetch(target, { cf: { cacheTtl: 3600 } });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
};

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
