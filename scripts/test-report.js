// One-off harness: run full audit pipeline against a single URL
// and write the markdown to ./reports/test/.
// Usage: node scripts/test-report.js https://example.com [Client Name]
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { discoverPages } = require('../lib/crawl');
const { auditUrl: lighthouseAudit, closeBrowser: closeLhBrowser } = require('../lib/lighthouse');
const { analyseUrl, fetchHtml } = require('../lib/seo');
const { auditPageImages } = require('../lib/images');
const { visionAuditUrl, closeBrowser: closeVisionBrowser } = require('../lib/vision');
const { buildClientMarkdown, summariseClient } = require('../lib/report');

async function auditPage(url, { runVision }) {
  const out = { url, errors: [] };
  try {
    out.seo = await analyseUrl(url);
    if (out.seo.error) out.errors.push(`seo: ${out.seo.error}`);
    const { html } = await fetchHtml(url).catch(() => ({ html: '' }));
    if (html) out.images = auditPageImages(html, url);
  } catch (err) {
    out.errors.push(`seo-fetch: ${err.message}`);
  }
  if (runVision) {
    try { out.vision = await visionAuditUrl(url); }
    catch (err) { out.vision = { error: String(err.message) }; }
  }
  return out;
}

async function main() {
  const url = process.argv[2];
  const name = process.argv[3] || (new URL(url)).hostname;
  if (!url) {
    console.error('Usage: node scripts/test-report.js https://example.com [Client Name]');
    process.exit(1);
  }

  const client = { name, url, status: 'Live', developer: '', team: '', notes: '' };
  const audit = { client, runAt: new Date().toISOString(), pages: [], errors: [] };

  console.log(`[discover] crawling ${url}...`);
  const maxPages = parseInt(process.env.QA_MAX_PAGES_PER_SITE || '5', 10);
  let pages = [url];
  try { pages = await discoverPages(url, { maxPages }); }
  catch (err) { audit.errors.push(`discover: ${err.message}`); }
  console.log(`[discover] picked ${pages.length} pages:`);
  pages.forEach((p) => console.log(`   - ${p}`));

  console.log(`[lighthouse] running mobile + desktop on homepage...`);
  audit.lighthouse = await lighthouseAudit(url).catch((err) => {
    audit.errors.push(`lighthouse: ${err.message}`);
    return null;
  });
  if (audit.lighthouse?.mobile?.scores) {
    const s = audit.lighthouse.mobile.scores;
    console.log(`   mobile: perf ${s.performance} · seo ${s.seo} · a11y ${s.accessibility} · bp ${s.bestPractices}`);
  }

  const maxVision = parseInt(process.env.QA_MAX_PAGES_FOR_VISION || '2', 10);
  for (let i = 0; i < pages.length; i++) {
    console.log(`[page ${i + 1}/${pages.length}] auditing ${pages[i]}...`);
    const result = await auditPage(pages[i], { runVision: i < maxVision });
    audit.pages.push(result);
    if (result.seo?.flags) console.log(`   ${result.seo.flags.length} SEO flags`);
    if (result.vision?.summary) console.log(`   vision: ${result.vision.summary}`);
  }

  await Promise.all([closeVisionBrowser().catch(() => {}), closeLhBrowser().catch(() => {})]);

  const md = buildClientMarkdown(client, audit);
  const summary = summariseClient(client, audit);

  const dir = path.join(__dirname, '..', 'reports', 'test');
  fs.mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[\\/:"*?<>|]+/g, '-').trim();
  const reportPath = path.join(dir, `${safe}.md`);
  const summaryPath = path.join(dir, `${safe}.summary.json`);
  fs.writeFileSync(reportPath, md);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('');
  console.log(`✅ Report written to ${reportPath}`);
  console.log(`   Health score: ${summary.healthScore}/100 (${summary.healthGrade}) — ${summary.healthStatus}`);
  console.log(`   ${summary.high} high · ${summary.medium} medium · ${summary.low} low`);
  console.log(`   Top fixes:`);
  for (const f of summary.topFixes) console.log(`     - [${f.severity}] ${f.flag} (${f.where})`);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
