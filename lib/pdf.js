// HTML → PDF rendering via Puppeteer.
// Reuses a single browser instance across the run for speed.

const puppeteer = require('puppeteer');

let browser = null;

async function getBrowser() {
  if (browser) {
    try {
      if (browser.process() && !browser.process().killed && browser.connected !== false) return browser;
    } catch {}
    browser = null;
  }
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
    protocolTimeout: 90 * 1000,
  });
  browser.on('disconnected', () => { browser = null; });
  return browser;
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

async function htmlToPdf(html, { width = '210mm', height = '297mm' } = {}) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 60 * 1000 });
    // Let layout/SVG settle a beat
    await new Promise((r) => setTimeout(r, 200));
    const buf = await page.pdf({
      width, height,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
    return buf;
  } finally {
    try { await page.close(); } catch {}
  }
}

module.exports = { htmlToPdf, closeBrowser };
