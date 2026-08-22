// /api/github.js
//
// Vercel Serverless Function.
// Fetches public repositories for github.com/Yea5inArafat server-side so
// that browsers never hit GitHub's unauthenticated 60 req/hr limit directly.
//
// Behaviour:
//   - Uses GITHUB_TOKEN if present (server-side only), otherwise falls back
//     to unauthenticated access automatically.
//   - Filters out forks, ranks the rest with rankScore() — a weighted mix of
//     stars, forks, recent-activity decay and a small relevance bonus — and
//     returns the top MAX_REPOS_RETURNED (6) repos. Deterministic tie-break
//     on last-updated, then name. Trims the payload to the fields the UI
//     actually needs.
//   - Sends CDN cache headers so GitHub is contacted at most ~once per hour
//     per Vercel region, with a 24h stale-while-revalidate window.
//   - Never lets a temporary GitHub failure poison the cache for long:
//     error responses get short/no cache lifetimes.
//   - Has an internal timeout so a hung upstream request can't hang the
//     function (and therefore the client) indefinitely.
//
// LIVE URL DETECTION:
//   githubUrl is always repo.html_url — the repository page. It is never
//   used as a stand-in for a live deployment.
//   liveUrl is resolved with this priority, and is only ever set to a URL
//   that is verifiably real:
//     1. repo.homepage, normalized (bare domains get "https://" prepended)
//        and validated as a real URL.
//     2. An auto-detected Vercel or Netlify deployment, found via GitHub's
//        own Deployments API (see detectAutoDeployment() below) — this is
//        how Vercel's and Netlify's GitHub integrations record every
//        deployment they make, so it reflects the real, current state of
//        the repo with no manual maintenance and no guessed URLs. Only a
//        deployment with a successful status and a vercel.app/netlify.app
//        (or custom netlify.com) host is accepted.
//     3. GitHub Pages, but only if the repo actually has Pages enabled
//        (repo.has_pages === true), using the real Pages URL shape
//        (username.github.io, or username.github.io/repo-name).
//     4. Otherwise liveUrl is null and the frontend simply won't render a
//        Live Demo button for that repo.

const GITHUB_USER = 'Yea5inArafat';
const PER_PAGE = 30;          // fetch a modest batch; UI only shows a handful
const MAX_REPOS_RETURNED = 6; // "top 6" repos, ranked by rankScore() below
const UPSTREAM_TIMEOUT_MS = 8000;
const LIVE_URL_VERIFY_TIMEOUT_MS = 2500;
const DEPLOY_DETECT_TIMEOUT_MS = 4000;
const DEPLOY_STATUSES_TO_CHECK = 5; // most recent deployments to look through per repo

const SUCCESS_CACHE = 'public, s-maxage=3600, stale-while-revalidate=86400';
const SHORT_ERROR_CACHE = 'public, s-maxage=30, stale-while-revalidate=120';
const RATE_LIMIT_CACHE = 'public, s-maxage=60, stale-while-revalidate=600';
const NOT_FOUND_CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

// Only these hosts count as an auto-detected "Vercel/Netlify deployment" —
// keeps this feature scoped to what was actually requested rather than
// treating every successful GitHub deployment (which could be anything:
// a CI job, a container registry push, etc.) as a live demo.
const DEPLOY_HOST_PATTERNS = [/\.vercel\.app$/i, /\.netlify\.app$/i, /\.netlify\.com$/i];

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

// Resolve the synchronously-known parts of a live URL (homepage, GitHub
// Pages). The Vercel/Netlify auto-detection step is async (it calls the
// GitHub Deployments API), so it's run separately in the handler below and
// only consulted when this returns null.
function resolveKnownLiveUrl(repo) {
  const fromHomepage = normalizeUrl(repo.homepage);
  if (fromHomepage) return fromHomepage;

  const pages = githubPagesUrl(repo);
  if (pages) return pages;

  return null;
}

// Queries GitHub's Deployments API for the repo's most recent production
// deployments and returns the environment_url of the newest one that both
// (a) has a successful status and (b) resolves to a Vercel or Netlify host.
// This is how those platforms' GitHub integrations record every deploy, so
// it reflects reality automatically — nothing here is guessed or hardcoded,
// and a repo with no such deployment (or a failed/removed one) simply gets
// null, which means no Live button. Fails open on any error (never breaks
// the repo card over deployment detection).
async function detectAutoDeployment(repo, headers) {
  try {
    const deployUrl =
      `https://api.github.com/repos/${repo.full_name}/deployments` +
      `?environment=production&per_page=${DEPLOY_STATUSES_TO_CHECK}`;
    const deployRes = await fetchWithTimeout(deployUrl, { headers }, DEPLOY_DETECT_TIMEOUT_MS);
    if (!deployRes.ok) return null;

    const deployments = await deployRes.json();
    if (!Array.isArray(deployments) || !deployments.length) return null;

    // Most recent first, regardless of what order the API happened to return.
    deployments.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());

    for (const deployment of deployments.slice(0, DEPLOY_STATUSES_TO_CHECK)) {
      if (!deployment || !deployment.id) continue;
      const statusUrl =
        `https://api.github.com/repos/${repo.full_name}/deployments/${deployment.id}/statuses?per_page=1`;
      const statusRes = await fetchWithTimeout(statusUrl, { headers }, DEPLOY_DETECT_TIMEOUT_MS);
      if (!statusRes.ok) continue;

      const statuses = await statusRes.json();
      if (!Array.isArray(statuses) || !statuses.length) continue;

      const latest = statuses[0];
      if (!latest || latest.state !== 'success') continue;

      const candidate = normalizeUrl(latest.environment_url || latest.target_url);
      if (!candidate) continue;

      let host = '';
      try { host = new URL(candidate).hostname; } catch (err) { continue; }
      if (DEPLOY_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
        return candidate;
      }
    }
    return null;
  } catch (err) {
    // Network error/timeout/unexpected shape — inconclusive, so just skip
    // auto-detection for this repo rather than failing its card.
    return null;
  }
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

// Weighted "top repo" score combining stars, forks, recent activity, and a
// small relevance bonus for repos with an actual description/topics set
// (a decent proxy for "this repo is finished/documented enough to show
// off", vs. a bare scratch repo with no metadata).
//
// Recency uses a decay curve rather than a hard cutoff so a repo updated
// yesterday clearly outranks one untouched for a year, without recency
// alone being able to drown out a repo with real stars/forks.
function recencyScore(updatedAt) {
  if (!updatedAt) return 0;
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86400000;
  if (!Number.isFinite(days) || days < 0) return 0;
  // 30 pts for updated today, decaying to ~0 by the 2-year mark.
  return 30 * Math.exp(-days / 180);
}

function rankScore(repo) {
  const stars = repo.stars || 0;
  const forks = repo.forks || 0;
  const relevance =
    (repo.description ? 4 : 0) +
    (Array.isArray(repo.topics) && repo.topics.length ? 3 : 0) +
    (repo.language ? 1 : 0);
  return stars * 6 + forks * 3 + recencyScore(repo.updatedAt) + relevance;
}

function pickFields(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.full_name,
    description: repo.description || null,
    githubUrl: repo.html_url,
    liveUrl: resolveKnownLiveUrl(repo),
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
      const scoreDiff = rankScore(b) - rankScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      // Deterministic tie-break when scores land equal (e.g. two brand-new,
      // zero-star repos): most recently updated first, then name.
      const dateDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_REPOS_RETURNED);

  // Auto-detect a Vercel/Netlify deployment (via GitHub's Deployments API)
  // for any repo that doesn't already have a liveUrl from its homepage
  // field or GitHub Pages. Runs only on the final top-6 list, not all 30
  // fetched repos, to keep API usage minimal.
  await Promise.all(
    clean.map(async (repo) => {
      if (repo.liveUrl) return;
      const detected = await detectAutoDeployment(repo, requestHeaders);
      if (detected) repo.liveUrl = detected;
    })
  );

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
