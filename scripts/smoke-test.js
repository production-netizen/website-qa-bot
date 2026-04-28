// Smoke test: runs the full audit pipeline on the first 2 Live clients.
// Useful for verifying everything wires up before kicking off a full run.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs = require('fs');

const { loadClients } = require('../lib/sheet');
const { discoverPages } = require('../lib/crawl');
const { auditUrl } = require('../lib/lighthouse');
const { analyseUrl, fetchHtml } = require('../lib/seo');
const { auditPageImages } = require('../lib/images');
const { visionAuditUrl, closeBrowser } = require('../lib/vision');
const { buildClientMarkdown, summariseClient, saveReportToDrive, saveLocalReport } = require('../lib/report');
const { postSummary } = require('../lib/discord');

(async () => {
  console.log('1. Loading clients from sheet…');
  const clients = await loadClients({ statusFilter: process.env.QA_STATUS_FILTER || 'Live' });
  console.log(`   ${clients.length} live clients found`);
  const subset = clients.slice(0, 2);
  console.log(`   smoke-testing on: ${subset.map((c) => c.name).join(', ')}`);

  const summaries = [];
  for (const client of subset) {
    console.log(`\n2. ${client.name} → ${client.url}`);
    const audit = { client, runAt: new Date().toISOString(), pages: [], errors: [] };

    console.log('   • discovering pages…');
    const pages = await discoverPages(client.url, { maxPages: 3 }).catch((e) => { console.log('     err:', e.message); return [client.url]; });
    console.log(`     → ${pages.length} pages: ${pages.map((u) => u.replace(client.url, '')).join(', ')}`);

    console.log('   • lighthouse (mobile + desktop)…');
    audit.lighthouse = await auditUrl(client.url).catch((e) => { console.log('     err:', e.message); return null; });
    if (audit.lighthouse?.mobile?.scores) {
      const m = audit.lighthouse.mobile.scores;
      console.log(`     mobile: perf=${m.performance} a11y=${m.accessibility} bp=${m.bestPractices} seo=${m.seo}`);
    }

    for (let i = 0; i < pages.length; i++) {
      const url = pages[i];
      console.log(`   • page ${i + 1}: ${url.replace(client.url, '/')}`);
      const pageAudit = { url, errors: [] };
      try {
        pageAudit.seo = await analyseUrl(url);
        const { html } = await fetchHtml(url).catch(() => ({ html: '' }));
        if (html) pageAudit.images = auditPageImages(html, url);
        console.log(`     seo flags=${pageAudit.seo.flags?.length || 0}, images flagged=${pageAudit.images?.flagged?.length || 0}`);
      } catch (err) {
        pageAudit.errors.push(`seo: ${err.message}`);
        console.log(`     err: ${err.message}`);
      }
      if (i === 0) {
        console.log('     • running vision review (Haiku)…');
        try {
          pageAudit.vision = await visionAuditUrl(url);
          if (pageAudit.vision?.summary) {
            console.log(`       vision: ${pageAudit.vision.summary} (${pageAudit.vision.issues?.length || 0} issues)`);
          } else if (pageAudit.vision?.error) {
            console.log(`       vision err: ${pageAudit.vision.error}`);
          }
        } catch (err) {
          pageAudit.vision = { error: err.message };
          console.log(`       vision crashed: ${err.message}`);
        }
      }
      audit.pages.push(pageAudit);
    }

    const md = buildClientMarkdown(client, audit);
    const safeName = client.name.replace(/[\\/:"*?<>|]+/g, '-');
    const date = new Date().toISOString().slice(0, 10);
    saveLocalReport({ md, fileName: `${safeName}.md`, dir: path.join(__dirname, '..', 'reports', date) });
    console.log(`   • local md saved`);

    let driveLink = null;
    if (process.env.REPORTS_DRIVE_FOLDER_ID) {
      try {
        const file = await saveReportToDrive({
          md,
          fileName: `${safeName} — Website QA — ${date}`,
          parentFolderId: process.env.REPORTS_DRIVE_FOLDER_ID,
        });
        driveLink = file.webViewLink;
        console.log(`   • drive doc: ${driveLink}`);
      } catch (err) {
        console.log(`   • drive save failed: ${err.message}`);
      }
    }

    const summary = summariseClient(client, audit);
    summary.reportLink = driveLink;
    summaries.push(summary);
  }

  await closeBrowser().catch(() => {});

  console.log('\n3. Posting Discord summary…');
  if (process.env.WEBSITE_AUDITS_WEBHOOK_URL) {
    await postSummary({
      webhookUrl: process.env.WEBSITE_AUDITS_WEBHOOK_URL,
      runAt: new Date().toISOString().slice(0, 16).replace('T', ' '),
      summaries,
      errors: [],
    });
    console.log('   ✓ Discord summary posted');
  } else {
    console.log('   skipped (no WEBSITE_AUDITS_WEBHOOK_URL)');
  }

  console.log('\n✓ smoke test complete');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
