const fetch = require('node-fetch');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (compatible; AHM-WebsiteQA/1.0; +https://alliedhealthmedia.co.uk)';

function priorityScore(href) {
  const lower = href.toLowerCase();
  let score = 0;
  if (/\/(treatment|treatments|service|services|condition|conditions|procedure|procedures)\//.test(lower)) score += 50;
  if (/\/(blog|news|press|insight|insights|article|articles)\//.test(lower)) score += 35;
  if (/\/(about|team|specialist|specialists)\//.test(lower)) score += 15;
  if (/\/(contact|book|appointment|location)/.test(lower)) score -= 5;
  if (/\/(wp-|admin|login|cart|checkout|tag\/|category\/)/.test(lower)) score -= 100;
  if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|css|js|xml|ico)$/.test(lower)) score -= 200;
  return score;
}

async function fetchText(url, timeoutMs = 30 * 1000) {
  const res = await fetch(url, { timeout: timeoutMs, headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

function parseSitemap(xml) {
  const urls = [];
  const submaps = [];
  const locRegex = /<loc[^>]*>([^<]+)<\/loc>/gi;
  const isIndex = /<sitemapindex\b/i.test(xml);
  let m;
  while ((m = locRegex.exec(xml))) {
    const loc = m[1].trim();
    if (isIndex) submaps.push(loc);
    else urls.push(loc);
  }
  return { urls, submaps };
}

async function discoverFromSitemap(rootUrl, max = 200) {
  const root = new URL(rootUrl);
  const candidates = [
    `${root.origin}/sitemap.xml`,
    `${root.origin}/sitemap_index.xml`,
    `${root.origin}/sitemap-index.xml`,
    `${root.origin}/wp-sitemap.xml`,
  ];
  const collected = new Set();
  for (const candidate of candidates) {
    try {
      const xml = await fetchText(candidate);
      const { urls, submaps } = parseSitemap(xml);
      urls.forEach((u) => collected.add(u));
      for (const sub of submaps.slice(0, 6)) {
        try {
          const subXml = await fetchText(sub);
          const { urls: subUrls } = parseSitemap(subXml);
          subUrls.forEach((u) => collected.add(u));
        } catch {}
        if (collected.size >= max) break;
      }
      if (collected.size > 0) break;
    } catch {}
  }
  return Array.from(collected).slice(0, max);
}

async function discoverFromHomepage(rootUrl, max = 60) {
  const root = new URL(rootUrl);
  const html = await fetchText(rootUrl).catch(() => '');
  if (!html) return [];
  const collected = new Set();
  const re = /href=["']([^"'#?]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1];
    try {
      const u = new URL(href, root.origin);
      if (u.origin !== root.origin) continue;
      collected.add(u.toString().split('#')[0]);
    } catch {}
    if (collected.size >= max * 2) break;
  }
  return Array.from(collected).slice(0, max);
}

// Patterns that should NEVER be audited — sitemaps, feeds, asset files,
// WP system endpoints. Usama explicitly called out XML/JSON noise in the
// 2026-04-29 C-suite meeting.
const NON_AUDITABLE_PATTERNS = [
  /\.(pdf|jpg|jpeg|png|gif|webp|svg|css|js|xml|ico|json|txt|woff2?|ttf|eot|mp4|mp3|zip|gz)(\?|$)/i,
  /\/(sitemap|sitemap_index|sitemap-index|wp-sitemap|news-sitemap|video-sitemap|image-sitemap)/i,
  /\/feed(\/|$|\?)/i,
  /\/(wp-json|wp-admin|wp-login|wp-cron|xmlrpc)/i,
  /\?(rest_route|wc-ajax)=/i,
  /\/(amp|amp\/)$/i,
];

function isAuditablePage(url) {
  if (!/^https?:\/\//.test(url)) return false;
  for (const re of NON_AUDITABLE_PATTERNS) if (re.test(url)) return false;
  return true;
}

async function discoverPages(rootUrl, { maxPages = 5, maxConsidered = 200 } = {}) {
  let candidates = await discoverFromSitemap(rootUrl, maxConsidered);
  if (candidates.length === 0) candidates = await discoverFromHomepage(rootUrl, 80);
  candidates = candidates.filter(isAuditablePage);

  const ranked = candidates
    .map((u) => ({ u, score: priorityScore(u) }))
    .sort((a, b) => b.score - a.score);

  const picked = [rootUrl];
  for (const { u, score } of ranked) {
    if (picked.length >= maxPages) break;
    if (u === rootUrl) continue;
    if (score < -50) continue;
    if (!picked.includes(u)) picked.push(u);
  }
  return picked.slice(0, maxPages);
}

module.exports = { discoverPages, isAuditablePage };
