// /api/github.js
//
// Vercel Serverless Function.
// Fetches public repositories for github.com/Yea5inArafat server-side so
// that browsers never hit GitHub's unauthenticated 60 req/hr limit directly.
//
// Behaviour:
//   - Uses GITHUB_TOKEN if present (server-side only), otherwise falls back
//     to unauthenticated access automatically.
//   - Filters out forks, sorts by last-updated (deterministic tie-break on
//     stars, then forks, then name), and trims the payload to the fields the
//     UI actually needs.
//   - Sends CDN cache headers so GitHub is contacted at most ~once per hour
//     per Vercel region, with a 24h stale-while-revalidate window.
//   - Never lets a temporary GitHub failure poison the cache for long:
//     error responses get short/no cache lifetimes.
//   - Has an internal timeout so a hung upstream request can't hang the
//     function (and therefore the client) indefinitely.
//
// LIVE URL DETECTION (this is the part that was previously broken):
//   githubUrl is always repo.html_url — the repository page. It is never
//   used as a stand-in for a live deployment.
//   liveUrl is resolved with this priority, and is only ever set to a URL
//   that is verifiably real:
//     1. repo.homepage, normalized (bare domains get "https://" prepended)
//        and validated as a real URL.
//     2. VERIFIED_LIVE_URLS below — a small, hand-maintained map of repos
//        whose live URL is confirmed elsewhere in this portfolio's own
//        content but isn't set on the GitHub repo's "homepage" field.
//        Every entry here must be manually verified before being added —
//        never auto-generate a vercel.app/netlify.app guess.
//     3. GitHub Pages, but only if the repo actually has Pages enabled
//        (repo.has_pages === true), using the real Pages URL shape
//        (username.github.io, or username.github.io/repo-name).
//     4. Otherwise liveUrl is null and the frontend simply won't render a
//        Live Demo button for that repo.

const GITHUB_USER = 'Yea5inArafat';
const PER_PAGE = 30;          // fetch a modest batch; UI only shows a handful
const MAX_REPOS_RETURNED = 12; // matches previous client-side per_page cap
const UPSTREAM_TIMEOUT_MS = 8000;
const LIVE_URL_VERIFY_TIMEOUT_MS = 2500;

const SUCCESS_CACHE = 'public, s-maxage=3600, stale-while-revalidate=86400';
const SHORT_ERROR_CACHE = 'public, s-maxage=30, stale-while-revalidate=120';
const RATE_LIMIT_CACHE = 'public, s-maxage=60, stale-while-revalidate=600';
const NOT_FOUND_CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

// Hand-verified overrides: use ONLY when a repo genuinely has a live,
// working deployment that GitHub's own "homepage" field doesn't reflect.
// Key = repo full_name ("owner/repo"). Confirm the URL actually loads
// before adding an entry — this file is the single source of truth for
// "known good" live links that bypass homepage detection.
const VERIFIED_LIVE_URLS = {
  'Yea5inArafat/Profolio': 'https://yea5inarafat.vercel.app/',
};

// Rejects obviously-placeholder/non-URL homepage values GitHub sometimes
// contains ("", "#", "null", "undefined", "-", "n/a", etc.), normalizes
// bare domains ("example.com" -> "https://example.com"), and returns a
// validated absolute URL or null.
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!candidate) return null;

  const junkValues = new Set(['#', 'null', 'undefined', 'n/a', 'na', '-', 'none', 'tbd']);
  if (junkValues.has(candidate.toLowerCase())) return null;

  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
    return parsed.href;
  } catch (err) {
    return null;
  }
}

function githubPagesUrl(repo) {
  if (!repo.has_pages) return null;
  const isUserSite = repo.name.toLowerCase() === `${GITHUB_USER.toLowerCase()}.github.io`;
  return isUserSite
    ? `https://${GITHUB_USER.toLowerCase()}.github.io/`
    : `https://${GITHUB_USER.toLowerCase()}.github.io/${repo.name}/`;
}

// Resolve the live URL using the documented priority order. Never falls
// back to guessing a Vercel/Netlify URL from the repo name.
function resolveLiveUrl(repo) {
  const fromHomepage = normalizeUrl(repo.homepage);
  if (fromHomepage) return fromHomepage;

  const verified = VERIFIED_LIVE_URLS[repo.full_name];
  if (verified) return verified;

  const pages = githubPagesUrl(repo);
  if (pages) return pages;

  return null;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Optional, best-effort, fail-open verification. This never removes a URL
// because of a timeout or network hiccup — it only demotes a URL when the
// server gives a clear, unambiguous "this really doesn't exist" (404/410).
// Anything else (2xx, redirects, 401/403 from bot protection, timeouts,
// DNS blips) is treated as "keep it" since those are common false
// negatives for perfectly live sites.
async function verifyLiveUrl(url) {
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD', redirect: 'follow' }, LIVE_URL_VERIFY_TIMEOUT_MS);
    if (res.status === 405 || res.status === 501) {
      // Some hosts reject HEAD; retry once with GET before judging.
      res = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, LIVE_URL_VERIFY_TIMEOUT_MS);
    }
    if (res.status === 404 || res.status === 410) return false;
    return true;
  } catch (err) {
    // Network error/timeout — inconclusive, so keep the known-good URL.
    return true;
  }
}

function pickFields(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    description: repo.description || null,
    githubUrl: repo.html_url,
    liveUrl: resolveLiveUrl(repo),
    language: repo.language || null,
    stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
    forks: typeof repo.forks_count === 'number' ? repo.forks_count : 0,
    updatedAt: repo.updated_at || null,
    topics: Array.isArray(repo.topics) ? repo.topics.slice(0, 6) : [],
    fork: repo.fork === true,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Accept-Encoding');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ error: 'method_not_allowed', message: 'Only GET is supported.' });
    return;
  }

  const requestHeaders = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'yea5inarafat-portfolio-github-widget',
  };

  // Optional authenticated access. Never sent to the client — this only
  // ever runs server-side inside the serverless function.
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    requestHeaders.Authorization = `Bearer ${token}`;
  }

  const apiUrl =
    `https://api.github.com/users/${encodeURIComponent(GITHUB_USER)}/repos` +
    `?type=owner&sort=updated&direction=desc&per_page=${PER_PAGE}`;

  let ghRes;
  try {
    ghRes = await fetchWithTimeout(apiUrl, { headers: requestHeaders }, UPSTREAM_TIMEOUT_MS);
  } catch (err) {
    // Network failure or our own abort timeout firing.
    res.setHeader('Cache-Control', SHORT_ERROR_CACHE);
    res.status(504).json({
      error: 'timeout',
      message: 'GitHub API did not respond in time.',
    });
    return;
  }

  if (ghRes.status === 404) {
    res.setHeader('Cache-Control', NOT_FOUND_CACHE);
    res.status(404).json({
      error: 'not_found',
      message: `GitHub user "${GITHUB_USER}" was not found.`,
    });
    return;
  }

  if (ghRes.status === 403 || ghRes.status === 429) {
    // Unauthenticated rate limit, secondary rate limit, or an invalid token
    // being rejected — all handled the same way: back off, don't retry hard.
    const remaining = ghRes.headers.get('x-ratelimit-remaining');
    const reset = ghRes.headers.get('x-ratelimit-reset');
    res.setHeader('Cache-Control', RATE_LIMIT_CACHE);
    res.status(429).json({
      error: 'rate_limited',
      message: 'GitHub API rate limit reached. Please try again shortly.',
      rate_limit_remaining: remaining !== null ? Number(remaining) : null,
      rate_limit_reset: reset !== null ? Number(reset) : null,
    });
    return;
  }

  if (!ghRes.ok) {
    // GitHub 5xx or anything else unexpected.
    res.setHeader('Cache-Control', SHORT_ERROR_CACHE);
    res.status(502).json({
      error: 'upstream_error',
      message: `GitHub API returned an unexpected status (${ghRes.status}).`,
    });
    return;
  }

  let repos;
  try {
    repos = await ghRes.json();
  } catch (err) {
    res.setHeader('Cache-Control', SHORT_ERROR_CACHE);
    res.status(502).json({ error: 'invalid_response', message: 'GitHub API returned an unreadable response.' });
    return;
  }

  if (!Array.isArray(repos)) {
    res.setHeader('Cache-Control', SHORT_ERROR_CACHE);
    res.status(502).json({ error: 'invalid_response', message: 'GitHub API returned an unexpected payload.' });
    return;
  }

  let clean = repos
    .filter((repo) => repo && repo.fork === false)
    .map(pickFields)
    .sort((a, b) => {
      const dateDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      if (dateDiff !== 0) return dateDiff;
      if (b.stars !== a.stars) return b.stars - a.stars;
      if (b.forks !== a.forks) return b.forks - a.forks;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_REPOS_RETURNED);

  // Optional, cached, timeout-protected verification pass. Runs in
  // parallel and only ever demotes a liveUrl on a clean 404/410 — never
  // blocks the response beyond LIVE_URL_VERIFY_TIMEOUT_MS per repo, and
  // a network hiccup here just keeps the URL as-is (fail open).
  await Promise.all(
    clean.map(async (repo) => {
      if (!repo.liveUrl) return;
      const stillLive = await verifyLiveUrl(repo.liveUrl);
      if (!stillLive) repo.liveUrl = null;
    })
  );

  // 'fork' was only needed for the filter above; don't ship it to the client.
  clean = clean.map(({ fork, ...rest }) => rest);

  res.setHeader('Cache-Control', SUCCESS_CACHE);
  res.status(200).json({
    user: GITHUB_USER,
    count: clean.length,
    repos: clean,
    fetched_at: new Date().toISOString(),
  });
};
