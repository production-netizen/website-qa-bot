// Run a fast audit + render the styled PDF + write it to disk.
// Usage: node scripts/test-pdf.js https://example.com [Client Name]
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const { auditClient } = require('../lib/audit');
const { generatePdf, summariseClient } = require('../lib/report');
const { buildHtml } = require('../lib/htmlReport');
const { closeBrowser: closeLhBrowser } = require('../lib/lighthouse');
const { closeBrowser: closeVisionBrowser } = require('../lib/vision');
const { closeBrowser: closePdfBrowser } = require('../lib/pdf');

(async () => {
  const url = process.argv[2];
  const name = process.argv[3] || (new URL(url)).hostname;
  if (!url) { console.error('Usage: node scripts/test-pdf.js https://example.com [Client Name]'); process.exit(1); }
  const client = { name, url, status: 'Test', developer: '', team: '' };

  console.log(`[1/3] Auditing ${url}...`);
  const audit = await auditClient(client, { maxPages: 3, maxVisionPages: 1, log: console.log });

  console.log(`[2/3] Rendering HTML + PDF...`);
  const html = buildHtml(client, audit);
  const dir = path.join(__dirname, '..', 'reports', 'test');
  fs.mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[\\/:"*?<>|]+/g, '-').trim();
  const htmlPath = path.join(dir, `${safe}.html`);
  fs.writeFileSync(htmlPath, html);

  const { pdf } = await generatePdf(client, audit);
  const pdfPath = path.join(dir, `${safe}.pdf`);
  fs.writeFileSync(pdfPath, pdf);

  const summary = summariseClient(client, audit);
  console.log(`\n[3/3] Done.`);
  console.log(`   HTML: ${htmlPath}`);
  console.log(`   PDF:  ${pdfPath} (${(pdf.length / 1024).toFixed(0)} KB)`);
  console.log(`   Score: ${summary.healthScore}/100 (${summary.healthGrade}) — ${summary.healthStatus}`);
  console.log(`   ${summary.high} high · ${summary.medium} medium · ${summary.low} low`);

  await Promise.all([closeLhBrowser(), closeVisionBrowser(), closePdfBrowser()].map((p) => p.catch(() => {})));
})().catch((e) => { console.error(e); process.exit(1); });
