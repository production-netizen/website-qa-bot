const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { getDrive } = require('./google');

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

function buildClientMarkdown(client, audit, opts = {}) {
  const lh = audit.lighthouse || {};
  const mobile = lh.mobile?.scores || {};
  const desktop = lh.desktop?.scores || {};

  const lines = [];
  lines.push(`# ${client.name} — Website QA`);
  lines.push('');
  lines.push(`**URL:** ${client.url}`);
  if (client.developer) lines.push(`**Developer:** ${client.developer}`);
  if (client.team) lines.push(`**Team:** ${client.team}`);
  lines.push(`**Status:** ${client.status}`);
  lines.push(`**Run:** ${audit.runAt}`);
  lines.push('');

  lines.push('## Lighthouse Scores');
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
    lines.push('### Core Web Vitals (Mobile)');
    lines.push(`- **LCP:** ${m.lcp || '—'} | **CLS:** ${m.cls || '—'} | **TBT:** ${m.tbt || '—'} | **FCP:** ${m.fcp || '—'}`);
    lines.push('');
  }

  for (const page of audit.pages || []) {
    lines.push(`## Page: ${page.url}`);
    lines.push('');
    lines.push(`- **Title:** ${page.seo?.title || '_missing_'}`);
    lines.push(`- **Meta Description:** ${page.seo?.metaDescription || '_missing_'}`);
    lines.push(`- **H1:** ${page.seo?.firstH1 || '_missing_'} (${page.seo?.h1Count ?? 0} on page)`);
    if (page.seo?.focusKeyword?.keyword) {
      lines.push(`- **Focus Keyword:** ${page.seo.focusKeyword.keyword} _(${page.seo.focusKeyword.source})_`);
    } else {
      lines.push(`- **Focus Keyword:** _not detected_`);
    }
    lines.push('');
    lines.push('**SEO / Compliance flags:**');
    lines.push(compactList(page.seo?.flags));
    lines.push('');

    if (page.images) {
      lines.push(`**Images:** ${page.images.total} total, ${page.images.externalCount} hosted off-domain, ${page.images.flagged.length} flagged`);
      if (page.images.flagged.length) {
        const list = page.images.flagged.slice(0, 6).map((f) => `- ${f.flags.join('; ')} — \`${f.src}\``);
        lines.push(list.join('\n'));
        if (page.images.flagged.length > 6) lines.push(`- _…and ${page.images.flagged.length - 6} more_`);
      }
      lines.push('');
    }

    if (page.vision && !page.vision.skipped && !page.vision.error) {
      lines.push(`**Layout / Vision Review:** ${page.vision.summary || ''}`);
      if (page.vision.issues?.length) {
        for (const issue of page.vision.issues) {
          const sev = (issue.severity || 'med').toUpperCase();
          lines.push(`- **[${sev}/${issue.viewport || 'both'}]** ${issue.issue}`);
        }
      }
      lines.push('');
    } else if (page.vision?.error) {
      lines.push(`_Vision review error: ${page.vision.error}_`);
      lines.push('');
    }
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

async function saveReportToDrive({ md, fileName, parentFolderId }) {
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
