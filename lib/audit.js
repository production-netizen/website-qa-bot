// Shared audit pipeline — used by both the daily cron run and the
// on-demand Discord listener. Keeps the orchestration in one place so
// both code paths produce identical output formats.

const fs = require('fs');
const path = require('path');

const { discoverPages } = require('./crawl');
const { auditUrl: lighthouseAudit } = require('./lighthouse');
const { analyseUrl, fetchHtml } = require('./seo');
const { auditPageImages } = require('./images');
const { visionAuditUrl } = require('./vision');
const {
  buildClientMarkdown,
  summariseClient,
  saveReportToDrive,
  savePdfToDrive,
  saveLocalReport,
  generatePdf,
} = require('./report');

async function auditPage(url, { runVision }) {
  const out = { url, errors: [] };
  try {
    out.seo = await analyseUrl(url);
    if (out.seo.error) out.errors.push(`seo: ${out.seo.error}`);
    const { html } = await fetchHtml(url).catch(() => ({ html: '' }));
    if (html) out.images = auditPageImages(html, url);
  } catch (err) {
    out.errors.push(`seo-fetch: ${err.message}`.slice(0, 200));
  }
  if (runVision) {
    try { out.vision = await visionAuditUrl(url); }
    catch (err) { out.vision = { error: String(err.message).slice(0, 200) }; }
  }
  return out;
}

/**
 * Runs the full audit pipeline against a single client.
 * Used by the daily cron AND by the Discord on-demand listener.
 *
 * @param {object} client — { name, url, status, developer?, team? }
 * @param {object} options
 *   @param {number} options.maxPages — page cap (default 5; on-demand uses 3)
 *   @param {number} options.maxVisionPages — vision-review page cap (default 2; on-demand uses 1)
 *   @param {function} options.log — log function (msg) => void
 */
async function auditClient(client, options = {}) {
  const {
    maxPages = parseInt(process.env.QA_MAX_PAGES_PER_SITE || '5', 10),
    maxVisionPages = parseInt(process.env.QA_MAX_PAGES_FOR_VISION || '2', 10),
    log = () => {},
  } = options;

  const runAt = new Date().toISOString();
  log(`[client] ${client.name} → ${client.url}`);
  const audit = { client, runAt, pages: [], errors: [] };

  let pages = [client.url];
  try {
    pages = await discoverPages(client.url, { maxPages });
  } catch (err) {
    audit.errors.push(`discover: ${err.message}`.slice(0, 200));
    pages = [client.url];
  }

  audit.lighthouse = await lighthouseAudit(client.url).catch((err) => {
    audit.errors.push(`lighthouse: ${err.message}`.slice(0, 200));
    return null;
  });

  for (let i = 0; i < pages.length; i++) {
    const url = pages[i];
    const runVision = i < maxVisionPages;
    const pageAudit = await auditPage(url, { runVision });
    audit.pages.push(pageAudit);
  }

  return audit;
}

function safeName(s) {
  return String(s).replace(/[\\/:"*?<>|]+/g, '-').trim().slice(0, 80);
}

/**
 * Persists an audit:
 *  - writes .md and .pdf locally
 *  - uploads Google Doc + PDF to Drive (parallel)
 * Returns { driveLink, pdfLink, localMdPath, localPdfPath, summary }
 */
async function persistAudit(audit, { reportsDir, log = () => {} } = {}) {
  const client = audit.client;
  const folderId = process.env.REPORTS_DRIVE_FOLDER_ID;
  const date = new Date().toISOString().slice(0, 10);
  const fileBase = `${safeName(client.name)} — Website QA — ${date}`;
  const md = buildClientMarkdown(client, audit);

  // Local copies
  const dailyDir = path.join(reportsDir, date);
  const localMdPath = saveLocalReport({ md, fileName: `${safeName(client.name)}.md`, dir: dailyDir });

  // PDF — generate once, save locally + upload to Drive
  let pdfBuffer = null;
  let localPdfPath = null;
  try {
    const { pdf } = await generatePdf(client, audit);
    pdfBuffer = pdf;
    localPdfPath = path.join(dailyDir, `${safeName(client.name)}.pdf`);
    fs.mkdirSync(dailyDir, { recursive: true });
    fs.writeFileSync(localPdfPath, pdfBuffer);
  } catch (err) {
    log(`[pdf] generate failed for ${client.name}: ${err.message}`);
  }

  // Upload Doc + PDF to Drive in parallel
  let driveLink = null; let pdfLink = null;
  if (folderId) {
    const ops = [];
    ops.push(saveReportToDrive({ md, fileName: fileBase, parentFolderId: folderId })
      .then((file) => { driveLink = file.webViewLink || null; })
      .catch((err) => log(`[drive] doc upload failed for ${client.name}: ${err.message}`)));
    if (pdfBuffer) {
      ops.push(savePdfToDrive({ pdfBuffer, fileName: `${fileBase}.pdf`, parentFolderId: folderId })
        .then((file) => { pdfLink = file.webViewLink || null; })
        .catch((err) => log(`[drive] pdf upload failed for ${client.name}: ${err.message}`)));
    }
    await Promise.all(ops);
  }

  const summary = summariseClient(client, audit);
  summary.reportLink = driveLink;
  summary.pdfLink = pdfLink;

  return { driveLink, pdfLink, localMdPath, localPdfPath, pdfBuffer, summary };
}

module.exports = { auditClient, auditPage, persistAudit };
