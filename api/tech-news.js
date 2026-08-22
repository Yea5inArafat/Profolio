// /api/tech-news.js
//
// Vercel Serverless Function.
// Aggregates the top 3 current tech news articles from a small set of
// well-known, publicly accessible RSS feeds — no API key required, and
// nothing here is hardcoded content.
//
// Behaviour (mirrors /api/github.js's approach):
//   - Fetches several feeds in parallel, each individually time-boxed so
//     one slow/broken feed can never hang or fail the whole response.
//   - Parses each feed with a small regex-based RSS reader (no XML
//     parsing dependency) — sufficient for these feeds' well-known,
//     consistent <item> shape.
//   - Combines everything, dedupes by normalized title and by URL, sorts
//     by publish date (newest first), and returns the top 3.
//   - CDN-cached for ~30 minutes so "current" news doesn't mean hitting
//     four upstream feeds on every single visitor.
//   - Fails open per-feed: a broken/slow feed is simply skipped. If every
//     feed fails, returns an empty articles array with a short cache
//     lifetime so the frontend shows its own error state and retries soon.

const FEEDS = [
  { url: 'https://techcrunch.com/feed/', source: 'TechCrunch' },
  { url: 'https://www.theverge.com/rss/index.xml', source: 'The Verge' },
  { url: 'https://feeds.arstechnica.com/arstechnica/index', source: 'Ars Technica' },
  { url: 'https://hnrss.org/frontpage', source: 'Hacker News' },
];

const FEED_TIMEOUT_MS = 5000;
const MAX_ARTICLES = 3;
const ITEMS_PER_FEED = 6; // pull a few per feed before ranking/deduping

const SUCCESS_CACHE = 'public, s-maxage=1800, stale-while-revalidate=7200';
const EMPTY_CACHE = 'public, s-maxage=60, stale-while-revalidate=300';

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTags(html) {
  if (!html) return '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  let val = m[1].trim();
  const cdata = val.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) val = cdata[1];
  return val.trim();
}

function extractThumbnail(block) {
  let m = block.match(/<media:(?:content|thumbnail)[^>]*url="([^"]+)"/i);
  if (m) return m[1];
  m = block.match(/<enclosure[^>]*url="([^"]+)"[^>]*type="image[^"]*"/i);
  if (m) return m[1];
  m = block.match(/<img[^>]*src="([^"]+)"/i);
  if (m) return m[1];
  return null;
}

function parseFeed(xml, source) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks.slice(0, ITEMS_PER_FEED)) {
    const rawTitle = extractTag(block, 'title');
    const title = decodeEntities(stripTags(rawTitle));
    const link = decodeEntities(extractTag(block, 'link')).trim();
    const pubDateRaw = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'published');
    const pubDate = pubDateRaw ? new Date(pubDateRaw) : null;
    const descRaw = extractTag(block, 'description') || extractTag(block, 'content:encoded') || extractTag(block, 'summary');
    let summary = stripTags(descRaw);
    if (summary.length > 160) summary = summary.slice(0, 157).trimEnd() + '…';
    const thumbnail = extractThumbnail(block);

    if (!title || !link) continue;

    items.push({
      title,
      summary: summary || null,
      source,
      url: link,
      publishedAt: pubDate && !isNaN(pubDate.getTime()) ? pubDate.toISOString() : null,
      thumbnail: thumbnail || null,
    });
  }
  return items;
}

async function fetchFeed(feed) {
  try {
    const res = await fetchWithTimeout(
      feed.url,
      { headers: { Accept: 'application/rss+xml, application/xml, text/xml' } },
      FEED_TIMEOUT_MS
    );
    if (!res.ok) return [];
    const xml = await res.text();
    return parseFeed(xml, feed.source);
  } catch (err) {
    return [];
  }
}

function normalizeForDedupe(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

  const results = await Promise.all(FEEDS.map(fetchFeed));
  const all = [].concat(...results);

  // Newest first. Items with no parseable date sink to the bottom rather
  // than being discarded outright.
  all.sort((a, b) => {
    const at = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const bt = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return bt - at;
  });

  const seenTitles = new Set();
  const seenUrls = new Set();
  const deduped = [];
  for (const item of all) {
    const key = normalizeForDedupe(item.title);
    if (!key || seenTitles.has(key) || seenUrls.has(item.url)) continue;
    seenTitles.add(key);
    seenUrls.add(item.url);
    deduped.push(item);
  }

  const articles = deduped.slice(0, MAX_ARTICLES);

  res.setHeader('Cache-Control', articles.length ? SUCCESS_CACHE : EMPTY_CACHE);
  res.status(200).json({
    count: articles.length,
    articles,
    fetched_at: new Date().toISOString(),
  });
};
