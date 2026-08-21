// /api/visits.js
//
// Serverless function (Vercel Node runtime) backing the portfolio's
// visitor counter. This is the ONLY place the counter's real value
// lives — the browser never stores the total itself, so a refresh,
// a cleared cache, or a new device all see the same persisted number.
//
// Storage: Upstash Redis (REST API), because it's a free, serverless-
// friendly key-value store that needs no server to run — a perfect
// fit for a static site deployed on Vercel.
//
//   1. Create a free database at https://console.upstash.com/
//   2. Copy its REST URL and REST token
//   3. In your Vercel project: Settings → Environment Variables, add
//        UPSTASH_REDIS_REST_URL
//        UPSTASH_REDIS_REST_TOKEN
//      (see .env.example) — these are read only on the server here
//      and are NEVER sent to the browser.
//
// If those env vars are missing (e.g. local `vercel dev` without
// setup), the function degrades gracefully to an in-memory counter
// for that single server instance, instead of crashing or hanging.
// It clearly is NOT persistent in that mode — that's expected until
// the env vars are configured.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const COUNTER_KEY = 'portfolio:visits:total';

// In-memory fallback only — resets on every cold start, and is not
// shared across serverless instances. Used solely so the endpoint
// still returns a sane number when Redis isn't configured yet.
let memoryFallbackCount = 0;

async function redisCommand(parts) {
  const res = await fetch(`${REDIS_URL}/${parts.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Upstash request failed: ${res.status}`);
  const data = await res.json();
  return data.result;
}

module.exports = async (req, res) => {
  // Basic hardening: only GET is meaningful for this endpoint.
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const shouldIncrement = req.query && (req.query.record === '1');
  const hasRedis = Boolean(REDIS_URL && REDIS_TOKEN);

  try {
    let total;
    if (hasRedis) {
      total = shouldIncrement
        ? await redisCommand(['INCR', COUNTER_KEY])
        : await redisCommand(['GET', COUNTER_KEY]);
      total = Number(total) || 0;
    } else {
      if (shouldIncrement) memoryFallbackCount += 1;
      total = memoryFallbackCount;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ total, persistent: hasRedis });
  } catch (err) {
    // Never leak internals; never hang. The client treats any non-200
    // or malformed body as "counter unavailable" and shows a dash.
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ total: memoryFallbackCount, persistent: false, degraded: true });
  }
};
