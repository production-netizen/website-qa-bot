const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { getDrive, makePublic } = require('./google');
const { enrichFlag } = require('./issueLibrary');
const { siteScore } = require('./score');
const { checkSiteStrengths } = require('./strengths');
const { buildHtml } = require('./htmlReport');
const { htmlToPdf } = require('./pdf');

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function score(n) { return n == null ? '—' : `${n}/100`; }
function emojiForScore(n) {
  if (n == null) return '⚪️';
  if (n >= 90) return '🟢';
  if (n >= 70) return '🟡';
  if (n >= 50) return '🟠';
  return '🔴';
}
function severityEmoji(sev) {
  return sev === 'high' ? '🔴' : sev === 'medium' ? '🟡' : '🟢';
}
function severityLabel(sev) {
  return sev === 'high' ? 'HIGH IMPACT' : sev === 'medium' ? 'MEDIUM IMPACT' : 'LOW IMPACT';
}
function pageLabel(client, page) {
  if (page.url === client.url) return 'Homepage';
  try { return new URL(page.url).pathname || page.url; } catch { return page.url; }
}

// ────────────────────────────────────────────────────────────────────────
// Severity classification (legacy bucket fallback when issueLibrary doesn't)
// ────────────────────────────────────────────────────────────────────────

function legacySeverity(flag) {
  const f = String(flag).toLowerCase();
  if (/^http \d|missing <title>|no <h1>|missing <meta name="viewport"|no <form>|no conversion path|no booking\/appointment cta|no styled cta buttons|critically low|seo low|accessibility low/.test(f)) return 'high';
  if (/multiple <h1>|title too short|title too long|meta description too|missing meta description|no "privacy policy"|no "terms"|no "cookie policy"|footer does not contain|no gtm container|missing <link rel="canonical|no json-ld|missing <html lang|no clickable phone|no social proof|no medical or local-business schema|many competing ctas|no gmc number|stock host|stock filename|long contact form|poor url slug|performance low|accessibility below|seo below|best practices low/.test(f)) return 'medium';
  return 'low';
}

// ────────────────────────────────────────────────────────────────────────
// Build the enriched issue list (every flag → root cause + fix + impact)
// ────────────────────────────────────────────────────────────────────────

function buildLighthouseFlags(audit) {
  const out = [];
  for (const strategy of ['mobile', 'desktop']) {
    const s = audit?.lighthouse?.[strategy]?.scores;
    if (!s) continue;
    const label = strategy === 'mobile' ? 'Mobile' : 'Desktop';
    if (s.performance != null && s.performance < 50) out.push(`${label} Performance critically low: ${s.performance}/100`);
    else if (s.performance != null && s.performance < 70) out.push(`${label} Performance low: ${s.performance}/100`);
    if (s.accessibility != null && s.accessibility < 70) out.push(`${label} Accessibility low: ${s.accessibility}/100`);
    else if (s.accessibility != null && s.accessibility < 90) out.push(`${label} Accessibility below target: ${s.accessibility}/100`);
    if (s.seo != null && s.seo < 70) out.push(`${label} SEO low: ${s.seo}/100`);
    else if (s.seo != null && s.seo < 90) out.push(`${label} SEO below target: ${s.seo}/100`);
    if (s.bestPractices != null && s.bestPractices < 80) out.push(`${label} Best Practices low: ${s.bestPractices}/100`);
  }
  return out;
}

function gatherIssues(client, audit) {
  const issues = [];
  const seen = new Set();
  const add = (where, flag, fallbackSev) => {
    const key = `${where}::${flag}`;
    if (seen.has(key)) return;
    seen.add(key);
    const enriched = enrichFlag(flag, fallbackSev || legacySeverity(flag));
    issues.push({ where, ...enriched });
  };

  for (const lhFlag of buildLighthouseFlags(audit)) {
    add('Site (Lighthouse)', lhFlag);
  }

  for (const page of audit.pages || []) {
    const where = pageLabel(client, page);
    for (const flag of (page.seo?.flags || [])) add(where, flag);
    for (const img of (page.images?.flagged || [])) {
      for (const f of (img.flags || [])) add(where, f);
    }
    for (const v of (page.vision?.issues || [])) {
      const flagText = `[${where} · ${v.viewport || 'both'} · ${v.category || 'vision'}] ${v.issue}${v.fix ? ` _Fix: ${v.fix}_` : ''}`;
      const sev = (v.severity || '').toLowerCase();
      const fallback = sev === 'critical' ? 'high' : (sev === 'high' || sev === 'medium' || sev === 'low') ? sev : 'medium';
      const enriched = enrichFlag(flagText, fallback);
      // For vision issues we override the howToFix from the AI's own suggestion (more specific to the page)
      const visionFix = v.fix ? v.fix : enriched.howToFix;
      issues.push({
        where,
        severity: fallback,
        track: v.category === 'broken' ? 'dev' : 'marketing',
        rootCause: `Visual review (${v.viewport || 'both'} viewport): ${v.issue}`,
        howToFix: visionFix,
        businessImpact: enriched.businessImpact,
        flag: v.issue,
      });
    }
  }
  return issues;
}

function bucketIssues(issues) {
  const by = { high: [], medium: [], low: [] };
  for (const i of issues) by[i.severity || 'low'].push(i);
  return by;
}

// Group issues that share the same root cause (same fix applies) — show one
// card per kind of issue, with a list of affected pages. This is what makes
// the report readable when a site has 20 pages with the same flaw.
function groupIssues(issues) {
  // Normalise the flag so similar variants ("Title too short: 18 chars" /
  // "Title too short: 22 chars") group together.
  const keyOf = (i) => {
    let s = String(i.flag || '').toLowerCase();
    s = s.replace(/\(\d+ chars/g, '(N chars').replace(/: \d+\/100/g, ': N/100').replace(/\(\d+ buttons/g, '(N buttons');
    s = s.replace(/"[^"]*"/g, '"…"');  // collapse quoted examples
    // Collapse the filename out of "stock filename: foo-1.webp" etc.
    s = s.replace(/^stock filename:\s*\S+/i, 'stock filename: <name>');
    s = s.replace(/^missing alt:\s*\S+/i, 'missing alt: <file>');
    s = s.replace(/^stock host:\s*\S+/i, 'stock host: <host>');
    return `${i.severity || 'low'}|${i.track}|${s.slice(0, 120)}`;
  };
  const groups = new Map();
  for (const issue of issues) {
    const k = keyOf(issue);
    if (!groups.has(k)) {
      groups.set(k, { ...issue, wheres: new Set([issue.where]), examples: [issue.flag] });
    } else {
      const g = groups.get(k);
      g.wheres.add(issue.where);
      if (g.examples.length < 3) g.examples.push(issue.flag);
    }
  }
  return [...groups.values()].map((g) => ({
    ...g,
    wheres: [...g.wheres],
    occurrences: g.wheres.size,
  }));
}

function splitTracks(issues) {
  return {
    marketing: issues.filter((i) => i.track === 'marketing'),
    dev: issues.filter((i) => i.track === 'dev'),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Top fixes (Pareto) — what should they fix first?
// ────────────────────────────────────────────────────────────────────────

function pickTopFixes(issues, n = 3) {
  // Group first, then rank: prefer issues that affect the most pages and
  // have the highest severity (Pareto — biggest leverage first).
  const grouped = groupIssues(issues);
  const sorted = grouped.sort((a, b) => {
    const sevRank = { high: 0, medium: 1, low: 2 };
    if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    if (a.track !== b.track) return a.track === 'marketing' ? -1 : 1;
    return 0;
  });
  return sorted.slice(0, n);
}

// ────────────────────────────────────────────────────────────────────────
// Markdown blocks
// ────────────────────────────────────────────────────────────────────────

function renderGroupedIssueCard(group, idx) {
  const lines = [];
  // Use the first example flag as the title (representative)
  const title = group.examples[0];
  lines.push(`##### ${idx}. ${title}`);
  lines.push('');
  lines.push(`- **Severity:** ${severityEmoji(group.severity)} ${severityLabel(group.severity)}`);
  if (group.occurrences === 1) {
    lines.push(`- **Where:** ${group.wheres[0]}`);
  } else {
    const shown = group.wheres.slice(0, 8);
    const more = group.wheres.length - shown.length;
    lines.push(`- **Where (${group.occurrences} pages):** ${shown.join(', ')}${more > 0 ? ` _+ ${more} more_` : ''}`);
  }
  lines.push(`- **Track:** ${group.track === 'dev' ? '🛠️ Development team' : '✍️ Marketing / CSM'}`);
  if (group.rootCause) lines.push(`- **Root cause:** ${group.rootCause}`);
  if (group.howToFix) lines.push(`- **How to fix:** ${group.howToFix}`);
  if (group.businessImpact) lines.push(`- **Business impact:** ${group.businessImpact}`);
  lines.push('');
  return lines.join('\n');
}

function renderIssueSection(title, issues, headingLevel = 4) {
  if (!issues.length) return '';
  const grouped = groupIssues(issues)
    // Sort by occurrence count desc within a section, then by severity (high first)
    .sort((a, b) => {
      const sevRank = { high: 0, medium: 1, low: 2 };
      if (sevRank[a.severity] !== sevRank[b.severity]) return sevRank[a.severity] - sevRank[b.severity];
      return b.occurrences - a.occurrences;
    });
  const lines = [];
  const hashes = '#'.repeat(headingLevel);
  lines.push(`${hashes} ${title}`);
  lines.push('');
  grouped.forEach((g, idx) => lines.push(renderGroupedIssueCard(g, idx + 1)));
  lines.push('');
  return lines.join('\n');
}

function renderUrlStructureTable(client, audit) {
  const rows = [];
  rows.push('| Page | Depth | Status | Title | Meta | H1 | Slug |');
  rows.push('|---|---|---|---|---|---|---|');
  for (const page of audit.pages || []) {
    const seo = page.seo || {};
    const slug = seo.slug || {};
    const yn = (b) => b ? '✅' : '❌';
    const titleOk = !!seo.title && seo.title.length >= 25 && seo.title.length <= 70;
    const metaOk = !!seo.metaDescription && seo.metaDescription.length >= 70 && seo.metaDescription.length <= 175;
    const h1Ok = seo.h1Count === 1;
    const status = seo.status ?? (seo.error ? 'ERR' : '?');
    rows.push(`| ${pageLabel(client, page)} | ${slug.depth ?? '—'} | ${status} | ${yn(titleOk)} | ${yn(metaOk)} | ${yn(h1Ok)} | ${slug.grade || '—'}${slug.reasons?.length ? ` (${slug.reasons.join(', ')})` : ''} |`);
  }
  return rows.join('\n');
}

function findDuplicateTitles(audit) {
  const map = new Map();
  for (const page of audit.pages || []) {
    const t = (page.seo?.title || '').trim();
    if (!t) continue;
    if (!map.has(t)) map.set(t, []);
    map.get(t).push(page.url);
  }
  return [...map.entries()].filter(([, urls]) => urls.length > 1);
}

function renderNavigationJourney(client, audit) {
  const home = (audit.pages || []).find((p) => p.url === client.url) || (audit.pages || [])[0];
  if (!home || !home.seo) return '_No homepage data captured._';

  const seo = home.seo;
  const cro = seo.cro || {};
  const compliance = seo.compliance || {};
  const nav = seo.nav || [];
  const forms = seo.forms || { primaryFields: 0, formCount: 0 };

  const lines = [];
  lines.push('### Top-Level Navigation');
  if (nav.length === 0) {
    lines.push('- _Could not detect a primary navigation menu._');
  } else {
    for (const n of nav) lines.push(`- ${n.text} → \`${n.href}\``);
  }
  lines.push('');

  lines.push('### Conversion Path');
  lines.push(`- **Phone (tap-to-call):** ${cro.phoneClickable ? '✅ <a href="tel:..."> present' : '❌ not clickable'}`);
  lines.push(`- **Email link:** ${cro.emailClickable ? '✅ present' : '❌ missing'}`);
  lines.push(`- **Booking CTA:** ${cro.bookingLink ? '✅ present' : '❌ missing'}`);
  lines.push(`- **Contact form:** ${forms.formCount > 0 ? `✅ ${forms.formCount} form(s), longest has ${forms.primaryFields} fields` : '❌ no form on page'}${forms.primaryFields >= 8 ? ' ⚠️ (long — target 3-5 fields)' : ''}`);
  lines.push(`- **CTA buttons on page:** ${cro.ctaButtonCount}`);
  lines.push('');

  lines.push('### Trust Signals');
  lines.push(`- **Testimonials:** ${cro.testimonials ? '✅' : '❌'}`);
  lines.push(`- **Star rating widgets:** ${cro.starRating ? '✅' : '❌'}`);
  lines.push(`- **Google Reviews / Trustpilot / Doctify:** ${cro.googleReviews ? '✅' : '❌'}`);
  lines.push(`- **GMC number visible:** ${cro.gmcNumber ? '✅' : '❌'}`);
  lines.push(`- **Medical Schema:** ${cro.medicalSchema ? '✅' : '❌'}`);
  lines.push(`- **Local-Business Schema:** ${cro.localBusinessSchema ? '✅' : '❌'}`);
  lines.push('');

  lines.push('### Footer Compliance');
  lines.push(`- **AHM credit:** ${compliance.footerAhm ? '✅' : '❌'}`);
  lines.push(`- **Privacy Policy:** ${compliance.privacy ? '✅' : '❌'}`);
  lines.push(`- **Terms:** ${compliance.terms ? '✅' : '❌'}`);
  lines.push(`- **Cookie Policy:** ${compliance.cookie ? '✅' : '❌'}`);
  lines.push(`- **Analytics (GTM/GA):** ${compliance.gtm ? '✅ GTM' : compliance.ga ? '✅ GA' : '❌ none detected'}`);

  return lines.join('\n');
}

function renderPerPage(client, audit, scoring) {
  const lines = [];
  for (let i = 0; i < (audit.pages || []).length; i++) {
    const page = audit.pages[i];
    const ps = scoring.pageScores[i] || {};
    const label = pageLabel(client, page);
    lines.push(`### ${label} — ${score(ps.score)} ${emojiForScore(ps.score)}`);
    lines.push(`URL: ${page.url}`);
    lines.push('');
    if (ps.breakdown && !ps.breakdown.broken) {
      lines.push(`**Sub-scores:** SEO ${ps.breakdown.seo}/100 · Compliance ${ps.breakdown.compliance}/100 · CRO ${ps.breakdown.cro}/100${ps.breakdown.visionPenalty ? ` · Vision penalty -${ps.breakdown.visionPenalty}` : ''}`);
      lines.push('');
    }
    const seo = page.seo || {};
    lines.push(`- **Title:** ${seo.title || '_missing_'}${seo.title ? ` _(${seo.title.length} chars)_` : ''}`);
    lines.push(`- **Meta Description:** ${seo.metaDescription || '_missing_'}${seo.metaDescription ? ` _(${seo.metaDescription.length} chars)_` : ''}`);
    lines.push(`- **H1:** ${seo.firstH1 || '_missing_'} _(${seo.h1Count ?? 0} on page)_`);
    if (seo.focusKeyword?.keyword) {
      lines.push(`- **Focus Keyword:** \`${seo.focusKeyword.keyword}\` _(${seo.focusKeyword.source})_`);
    } else {
      lines.push(`- **Focus Keyword:** _not detected_`);
    }
    if (seo.compliance) {
      const c = seo.compliance;
      const yn = (b) => b ? '✅' : '❌';
      lines.push(`- **Compliance:** ${yn(c.footerAhm)} AHM footer · ${yn(c.privacy)} Privacy · ${yn(c.terms)} Terms · ${yn(c.cookie)} Cookie · ${yn(c.form)} Form · ${yn(c.gtm || c.ga)} GTM/GA`);
    }
    if (seo.cro) {
      const c = seo.cro;
      const yn = (b) => b ? '✅' : '❌';
      lines.push(`- **CRO Signals:** ${yn(c.phoneClickable)} Tel · ${yn(c.bookingLink)} Booking · ${yn(c.testimonials || c.starRating || c.googleReviews)} Social proof · ${yn(c.medicalSchema || c.localBusinessSchema)} Schema · ${yn(c.gmcNumber)} GMC · CTAs: ${c.ctaButtonCount}`);
    }
    if (page.images) {
      lines.push(`- **Images:** ${page.images.total} total · ${page.images.externalCount} off-domain · ${page.images.flagged.length} flagged`);
    }
    if (page.vision?.summary) {
      lines.push(`- **Layout review:** ${page.vision.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// Main report builder — Manus-style structure
// ────────────────────────────────────────────────────────────────────────

function buildClientMarkdown(client, audit) {
  const lh = audit.lighthouse || {};
  const mobile = lh.mobile?.scores || {};
  const desktop = lh.desktop?.scores || {};
  const scoring = siteScore(audit);
  const issues = gatherIssues(client, audit);
  const buckets = bucketIssues(issues);
  const tracks = splitTracks(issues);
  const topFixes = pickTopFixes(issues, 3);
  const strengths = checkSiteStrengths(audit);
  const dupTitles = findDuplicateTitles(audit);

  const lines = [];

  // ─── HEADER ────────────────────────────────────────────────────────
  lines.push(`# ${client.name} — Website QA Report`);
  lines.push('');
  lines.push(`**URL:** ${client.url}`);
  if (client.developer) lines.push(`**Developer:** ${client.developer}`);
  if (client.team) lines.push(`**Team:** ${client.team}`);
  lines.push(`**Status:** ${client.status}`);
  lines.push(`**Audited:** ${audit.runAt}`);
  lines.push(`**Pages audited:** ${audit.pages?.length || 0}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 1. EXECUTIVE SUMMARY ──────────────────────────────────────────
  lines.push('## 1. Executive Summary');
  lines.push('');
  lines.push(`> **Overall Health: ${scoring.score}/100 (Grade ${scoring.grade}) — ${scoring.status}**`);
  lines.push('');
  // Show grouped (unique-kind) counts so the numbers don't double-count the
  // same issue across pages; raw counts also shown for completeness.
  const uniqHigh = groupIssues(buckets.high).length;
  const uniqMedium = groupIssues(buckets.medium).length;
  const uniqLow = groupIssues(buckets.low).length;
  lines.push(`🔴 **${uniqHigh} high impact** &nbsp;·&nbsp; 🟡 **${uniqMedium} medium impact** &nbsp;·&nbsp; 🟢 **${uniqLow} observations** _(across ${audit.pages?.length || 0} pages)_`);
  lines.push('');
  lines.push('### Lighthouse Scoreboard');
  lines.push('');
  lines.push('| Category | Mobile | Desktop |');
  lines.push('|---|---|---|');
  lines.push(`| Performance | ${emojiForScore(mobile.performance)} ${score(mobile.performance)} | ${emojiForScore(desktop.performance)} ${score(desktop.performance)} |`);
  lines.push(`| Accessibility | ${emojiForScore(mobile.accessibility)} ${score(mobile.accessibility)} | ${emojiForScore(desktop.accessibility)} ${score(desktop.accessibility)} |`);
  lines.push(`| Best Practices | ${emojiForScore(mobile.bestPractices)} ${score(mobile.bestPractices)} | ${emojiForScore(desktop.bestPractices)} ${score(desktop.bestPractices)} |`);
  lines.push(`| SEO (technical) | ${emojiForScore(mobile.seo)} ${score(mobile.seo)} | ${emojiForScore(desktop.seo)} ${score(desktop.seo)} |`);
  lines.push('');
  if (lh.mobile?.metrics) {
    const m = lh.mobile.metrics;
    lines.push(`**Mobile Core Web Vitals:** LCP ${m.lcp || '—'} · CLS ${m.cls || '—'} · TBT ${m.tbt || '—'} · FCP ${m.fcp || '—'} · Speed Index ${m.speedIndex || '—'}`);
    lines.push('');
  }

  // ─── TOP FIXES ─────────────────────────────────────────────────────
  if (topFixes.length) {
    lines.push('### 🎯 Top 3 Fixes (Pareto — start here)');
    lines.push('');
    topFixes.forEach((f, i) => {
      const flag = (f.examples && f.examples[0]) || f.flag;
      const where = f.occurrences > 1 ? `${f.occurrences} pages` : (f.wheres ? f.wheres[0] : f.where);
      lines.push(`${i + 1}. **${flag}** _(${where})_`);
      if (f.howToFix) lines.push(`   → ${f.howToFix}`);
    });
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // ─── 2. STRENGTHS ──────────────────────────────────────────────────
  lines.push('## 2. What This Site Does Well');
  lines.push('');
  if (strengths.length === 0) {
    lines.push('_No specific strengths detected — focus is on the issues below._');
  } else {
    strengths.forEach((s) => lines.push(`- ✅ ${s}`));
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 3. ISSUES & FIXES — split by track ───────────────────────────
  lines.push('## 3. Issues & Fixes');
  lines.push('');
  lines.push(`Each issue below has: **Severity** · **Where** · **Track** · **Root cause** · **How to fix** · **Business impact**.`);
  lines.push('');
  lines.push('### ✍️ Marketing / CSM Track');
  lines.push('_Fixes the consultant or CSM can action through WordPress admin or content updates._');
  lines.push('');
  const mkBuckets = bucketIssues(tracks.marketing);
  let mkContent = '';
  mkContent += renderIssueSection('🔴 High Impact', mkBuckets.high, 4);
  mkContent += renderIssueSection('🟡 Medium Impact', mkBuckets.medium, 4);
  mkContent += renderIssueSection('🟢 Observations', mkBuckets.low, 4);
  if (!mkContent.trim()) mkContent = '_No marketing-track issues found._\n\n';
  lines.push(mkContent);

  lines.push('### 🛠️ Development Team Track');
  lines.push('_Fixes that need a developer / agency — code, hosting, plugins, schema._');
  lines.push('');
  const devBuckets = bucketIssues(tracks.dev);
  let devContent = '';
  devContent += renderIssueSection('🔴 High Impact', devBuckets.high, 4);
  devContent += renderIssueSection('🟡 Medium Impact', devBuckets.medium, 4);
  devContent += renderIssueSection('🟢 Observations', devBuckets.low, 4);
  if (!devContent.trim()) devContent = '_No development-track issues found._\n\n';
  lines.push(devContent);

  lines.push('---');
  lines.push('');

  // ─── 4. PER-PAGE ANALYSIS ─────────────────────────────────────────
  lines.push('## 4. Per-Page Analysis');
  lines.push('');
  lines.push(renderPerPage(client, audit, scoring));
  lines.push('---');
  lines.push('');

  // ─── 5. URL STRUCTURE ─────────────────────────────────────────────
  lines.push('## 5. URL Structure & Indexability');
  lines.push('');
  lines.push(renderUrlStructureTable(client, audit));
  lines.push('');
  if (dupTitles.length) {
    lines.push('### Duplicate <title> tags detected');
    for (const [t, urls] of dupTitles) {
      lines.push(`- **"${t}"** appears on:`);
      urls.forEach((u) => lines.push(`  - ${u}`));
    }
    lines.push('');
  }
  lines.push('---');
  lines.push('');

  // ─── 6. NAVIGATION & JOURNEY ──────────────────────────────────────
  lines.push('## 6. Navigation & Patient Journey');
  lines.push('');
  lines.push(renderNavigationJourney(client, audit));
  lines.push('');
  lines.push('---');
  lines.push('');

  // ─── 7. ERRORS (if any) ───────────────────────────────────────────
  if (audit.errors && audit.errors.length) {
    lines.push('## 7. Audit Errors');
    lines.push('');
    audit.errors.forEach((e) => lines.push(`- ${e}`));
    lines.push('');
  }

  lines.push(`_Generated by AHM Website QA Bot — ${audit.runAt}_`);

  return lines.join('\n');
}

// ────────────────────────────────────────────────────────────────────────
// Discord summary helper data
// ────────────────────────────────────────────────────────────────────────

function summariseClient(client, audit) {
  const m = audit.lighthouse?.mobile?.scores || {};
  const d = audit.lighthouse?.desktop?.scores || {};
  const scoring = siteScore(audit);
  const issues = gatherIssues(client, audit);
  const buckets = bucketIssues(issues);
  const topFixes = pickTopFixes(issues, 3);
  // Unique-kind counts (don't double-count same issue across many pages)
  const high = groupIssues(buckets.high).length;
  const medium = groupIssues(buckets.medium).length;
  const low = groupIssues(buckets.low).length;
  return {
    name: client.name,
    url: client.url,
    perfMobile: m.performance ?? null,
    perfDesktop: d.performance ?? null,
    seoMobile: m.seo ?? null,
    flagCount: issues.length,
    pages: (audit.pages || []).length,
    healthScore: scoring.score,
    healthGrade: scoring.grade,
    healthStatus: scoring.status,
    high,
    medium,
    low,
    topFixes: topFixes.map((f) => ({
      flag: (f.examples && f.examples[0]) || f.flag,
      where: f.occurrences > 1 ? `${f.occurrences} pages` : (f.wheres ? f.wheres[0] : f.where),
      severity: f.severity,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Drive / disk persistence
// ────────────────────────────────────────────────────────────────────────

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

async function savePdfToDrive({ pdfBuffer, fileName, parentFolderId, makePublicLink = true }) {
  const drive = getDrive();
  const stream = Readable.from(pdfBuffer);
  const requestBody = {
    name: fileName,
    mimeType: 'application/pdf',
    parents: parentFolderId ? [parentFolderId] : undefined,
  };
  const media = { mimeType: 'application/pdf', body: stream };
  const res = await drive.files.create({ requestBody, media, fields: 'id, webViewLink, name' });
  if (makePublicLink) {
    try { await makePublic(res.data.id); }
    catch (err) { console.warn(`makePublic failed for ${res.data.id}: ${err.message}`); }
  }
  return res.data;
}

async function generatePdf(client, audit) {
  const html = buildHtml(client, audit);
  const pdf = await htmlToPdf(html);
  return { html, pdf };
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

module.exports = {
  buildClientMarkdown,
  summariseClient,
  saveReportToDrive,
  savePdfToDrive,
  saveLocalReport,
  generatePdf,
  gatherIssues,
  groupIssues,
  pickTopFixes,
};
