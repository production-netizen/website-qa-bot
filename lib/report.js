const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { getDrive, makePublic } = require('./google');

function score(n) {
  if (n == null) return '—';
  return `${n}/100`;
}

function emojiForScore(n) {
  if (n == null) return '⚪️';
  if (n >= 90) return '🟢';
  if (n >= 70) return '🟡';
  if (n >= 50) return '🟠';
  return '🔴';
}

function compactList(items, max = 10) {
  if (!items || items.length === 0) return '_None_';
  const head = items.slice(0, max).map((i) => `- ${i}`).join('\n');
  if (items.length > max) return `${head}\n- _…and ${items.length - max} more_`;
  return head;
}

// Classify a finding into a severity bucket.
// Returns 'high' | 'medium' | 'low'
function classifyFlag(flag, ctx = {}) {
  const f = String(flag).toLowerCase();
  // HIGH IMPACT — directly hurts conversion or page is broken
  if (/^http \d/.test(f)) return 'high';
  if (/missing <title>|no <h1>|missing viewport/.test(f)) return 'high';
  if (/no form on page|no way to contact|no clear booking|no styled cta button/.test(f)) return 'high';
  // MEDIUM
  if (/multiple <h1>|short title|long title|short meta description|long meta description|missing meta description/.test(f)) return 'medium';
  if (/no privacy policy|no terms link|no cookie policy/.test(f)) return 'medium';
  if (/no "allied health media" in footer/.test(f)) return 'medium';
  if (/no gtm\/ga tag|missing canonical|no json-ld|missing <html lang>/.test(f)) return 'medium';
  if (/no clickable tel|no social proof|no medical\/local-business json-ld|many competing ctas/.test(f)) return 'medium';
  // LOW
  return 'low';
}

function classifyVisionIssue(issue) {
  const sev = (issue.severity || '').toLowerCase();
  if (sev === 'high' || sev === 'critical') return 'high';
  if (sev === 'low') return 'low';
  return 'medium';
}

function classifyImageFlag(flag) {
  const f = String(flag).toLowerCase();
  if (/stock host|stock filename/.test(f)) return 'medium';
  if (/missing alt/.test(f)) return 'low';
  return 'low';
}

function classifyLighthouse(audit) {
  const findings = { high: [], medium: [], low: [] };
  for (const strategy of ['mobile', 'desktop']) {
    const s = audit?.[strategy]?.scores;
    if (!s) continue;
    const label = strategy === 'mobile' ? 'Mobile' : 'Desktop';
    if (s.performance != null && s.performance < 50) findings.high.push(`${label} Performance critically low: ${s.performance}/100`);
    else if (s.performance != null && s.performance < 70) findings.medium.push(`${label} Performance low: ${s.performance}/100`);
    if (s.accessibility != null && s.accessibility < 70) findings.high.push(`${label} Accessibility low: ${s.accessibility}/100`);
    else if (s.accessibility != null && s.accessibility < 90) findings.medium.push(`${label} Accessibility below target: ${s.accessibility}/100`);
    if (s.seo != null && s.seo < 70) findings.high.push(`${label} SEO low: ${s.seo}/100`);
    else if (s.seo != null && s.seo < 90) findings.medium.push(`${label} SEO below target: ${s.seo}/100`);
    if (s.bestPractices != null && s.bestPractices < 80) findings.medium.push(`${label} Best Practices low: ${s.bestPractices}/100`);
  }
  return findings;
}

function gatherFindings(client, audit) {
  const findings = { high: [], medium: [], low: [] };

  const lh = classifyLighthouse(audit.lighthouse || {});
  for (const sev of ['high', 'medium', 'low']) findings[sev].push(...lh[sev]);

  for (const page of audit.pages || []) {
    const where = page.url === client.url ? 'Homepage' : page.url.replace(client.url, '/');
    for (const flag of (page.seo?.flags || [])) {
      const sev = classifyFlag(flag);
      findings[sev].push(`[${where}] ${flag}`);
    }
    for (const img of (page.images?.flagged || [])) {
      for (const f of (img.flags || [])) {
        const sev = classifyImageFlag(f);
        findings[sev].push(`[${where}] ${f}`);
      }
    }
    for (const issue of (page.vision?.issues || [])) {
      const sev = classifyVisionIssue(issue);
      const vp = issue.viewport ? `${issue.viewport}` : 'both';
      const cat = issue.category ? `${issue.category} · ` : '';
      const fix = issue.fix ? ` _Fix: ${issue.fix}_` : '';
      findings[sev].push(`[${where} · ${vp} · ${cat}vision] ${issue.issue}${fix}`);
    }
  }

  // Dedupe within each bucket
  for (const sev of ['high', 'medium', 'low']) {
    findings[sev] = Array.from(new Set(findings[sev]));
  }
  return findings;
}

function buildClientMarkdown(client, audit, opts = {}) {
  const lh = audit.lighthouse || {};
  const mobile = lh.mobile?.scores || {};
  const desktop = lh.desktop?.scores || {};
  const findings = gatherFindings(client, audit);

  const lines = [];
  lines.push(`# ${client.name} — Website QA`);
  lines.push('');
  lines.push(`**URL:** ${client.url}`);
  if (client.developer) lines.push(`**Developer:** ${client.developer}`);
  if (client.team) lines.push(`**Team:** ${client.team}`);
  lines.push(`**Status:** ${client.status}`);
  lines.push(`**Run:** ${audit.runAt}`);
  lines.push(`**Pages audited:** ${audit.pages?.length || 0}`);
  lines.push('');

  // ─── TL;DR / scoreboard ───
  lines.push('## At a Glance');
  lines.push('');
  lines.push(`> 🔴 **${findings.high.length} high impact** &nbsp;·&nbsp; 🟡 **${findings.medium.length} medium impact** &nbsp;·&nbsp; 🟢 **${findings.low.length} low impact / observations**`);
  lines.push('');
  lines.push('| Category | Mobile | Desktop |');
  lines.push('|---|---|---|');
  lines.push(`| Performance | ${emojiForScore(mobile.performance)} ${score(mobile.performance)} | ${emojiForScore(desktop.performance)} ${score(desktop.performance)} |`);
  lines.push(`| Accessibility | ${emojiForScore(mobile.accessibility)} ${score(mobile.accessibility)} | ${emojiForScore(desktop.accessibility)} ${score(desktop.accessibility)} |`);
  lines.push(`| Best Practices | ${emojiForScore(mobile.bestPractices)} ${score(mobile.bestPractices)} | ${emojiForScore(desktop.bestPractices)} ${score(desktop.bestPractices)} |`);
  lines.push(`| SEO | ${emojiForScore(mobile.seo)} ${score(mobile.seo)} | ${emojiForScore(desktop.seo)} ${score(desktop.seo)} |`);
  lines.push('');

  if (lh.mobile?.metrics) {
    const m = lh.mobile.metrics;
    lines.push('**Mobile Core Web Vitals:**');
    lines.push(`LCP ${m.lcp || '—'} · CLS ${m.cls || '—'} · TBT ${m.tbt || '—'} · FCP ${m.fcp || '—'} · Speed Index ${m.speedIndex || '—'}`);
    lines.push('');
  }

  // ─── 🔴 HIGH IMPACT ───
  lines.push('## 🔴 High Impact — Fix Immediately');
  lines.push('');
  if (findings.high.length === 0) {
    lines.push('_None_ — no critical issues detected.');
  } else {
    findings.high.forEach((f) => lines.push(`- 🔴 ${f}`));
  }
  lines.push('');

  // ─── 🟡 MEDIUM IMPACT ───
  lines.push('## 🟡 Medium Impact — Schedule a Fix');
  lines.push('');
  if (findings.medium.length === 0) {
    lines.push('_None_');
  } else {
    findings.medium.forEach((f) => lines.push(`- 🟡 ${f}`));
  }
  lines.push('');

  // ─── 🟢 LOW IMPACT ───
  lines.push('## 🟢 Low Impact / Observations');
  lines.push('');
  if (findings.low.length === 0) {
    lines.push('_None_');
  } else {
    const max = 30;
    findings.low.slice(0, max).forEach((f) => lines.push(`- 🟢 ${f}`));
    if (findings.low.length > max) lines.push(`- _…and ${findings.low.length - max} more_`);
  }
  lines.push('');

  // ─── PER-PAGE DETAIL ───
  lines.push('---');
  lines.push('');
  lines.push('## Per-Page Detail');
  lines.push('');

  for (const page of audit.pages || []) {
    const label = page.url === client.url ? 'Homepage' : page.url.replace(client.url, '/');
    lines.push(`### ${label}`);
    lines.push(`URL: ${page.url}`);
    lines.push('');
    lines.push(`- **Title:** ${page.seo?.title || '_missing_'}${page.seo?.title ? ` _(${page.seo.title.length} chars)_` : ''}`);
    lines.push(`- **Meta Description:** ${page.seo?.metaDescription || '_missing_'}${page.seo?.metaDescription ? ` _(${page.seo.metaDescription.length} chars)_` : ''}`);
    lines.push(`- **H1:** ${page.seo?.firstH1 || '_missing_'} _(${page.seo?.h1Count ?? 0} on page)_`);
    if (page.seo?.focusKeyword?.keyword) {
      lines.push(`- **Focus Keyword:** \`${page.seo.focusKeyword.keyword}\` _(${page.seo.focusKeyword.source})_`);
    } else {
      lines.push(`- **Focus Keyword:** _not detected_`);
    }
    if (page.seo?.compliance) {
      const c = page.seo.compliance;
      const yn = (b) => b ? '✅' : '❌';
      lines.push(`- **Compliance:** ${yn(c.footerAhm)} AHM footer · ${yn(c.privacy)} Privacy · ${yn(c.terms)} Terms · ${yn(c.cookie)} Cookie · ${yn(c.form)} Form · ${yn(c.gtm || c.ga)} GTM/GA`);
    }
    if (page.seo?.cro) {
      const c = page.seo.cro;
      const yn = (b) => b ? '✅' : '❌';
      lines.push(`- **CRO Signals:** ${yn(c.phoneClickable)} Tel · ${yn(c.bookingLink)} Booking · ${yn(c.testimonials || c.starRating || c.googleReviews)} Social proof · ${yn(c.medicalSchema || c.localBusinessSchema)} Schema · ${yn(c.gmcNumber)} GMC · CTAs: ${c.ctaButtonCount}`);
    }
    if (page.images) {
      lines.push(`- **Images:** ${page.images.total} total · ${page.images.externalCount} off-domain · ${page.images.flagged.length} flagged`);
    }
    if (page.vision?.summary) {
      lines.push(`- **Layout:** ${page.vision.summary}`);
    }
    lines.push('');
  }

  if (audit.errors && audit.errors.length) {
    lines.push('## Errors');
    lines.push(compactList(audit.errors));
    lines.push('');
  }

  return lines.join('\n');
}

function summariseClient(client, audit) {
  const m = audit.lighthouse?.mobile?.scores || {};
  const d = audit.lighthouse?.desktop?.scores || {};
  const flagCount = (audit.pages || []).reduce((acc, p) => acc + (p.seo?.flags?.length || 0) + (p.vision?.issues?.length || 0) + (p.images?.flagged?.length || 0), 0);
  return {
    name: client.name,
    url: client.url,
    perfMobile: m.performance ?? null,
    perfDesktop: d.performance ?? null,
    seoMobile: m.seo ?? null,
    flagCount,
    pages: (audit.pages || []).length,
  };
}

async function saveReportToDrive({ md, fileName, parentFolderId, makePublicLink = true }) {
  const drive = getDrive();
  const buffer = Buffer.from(md, 'utf8');
  const stream = Readable.from(buffer);
  const requestBody = {
    name: fileName,
    mimeType: 'application/vnd.google-apps.document',
    parents: parentFolderId ? [parentFolderId] : undefined,
  };
  const media = { mimeType: 'text/markdown', body: stream };
  const res = await drive.files.create({ requestBody, media, fields: 'id, webViewLink, name' });
  if (makePublicLink) {
    try { await makePublic(res.data.id); }
    catch (err) { console.warn(`makePublic failed for ${res.data.id}: ${err.message}`); }
  }
  return res.data;
}

function ensureLocalDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function saveLocalReport({ md, fileName, dir }) {
  ensureLocalDir(dir);
  const target = path.join(dir, fileName);
  fs.writeFileSync(target, md, 'utf8');
  return target;
}

module.exports = { buildClientMarkdown, summariseClient, saveReportToDrive, saveLocalReport };
