// Local Lighthouse runner — uses Puppeteer-managed Chromium so we avoid
// PageSpeed Insights quota errors (which throttle hard without an API key).

const puppeteer = require('puppeteer');

let browser = null;
async function getBrowser() {
  if (browser && browser.connected !== false) return browser;
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
    ],
  });
  return browser;
}

async function closeBrowser() {
  if (browser) {
    try { await browser.close(); } catch {}
    browser = null;
  }
}

async function runLighthouse(url, strategy) {
  const lighthouse = (await import('lighthouse')).default;
  const b = await getBrowser();
  const wsEndpoint = b.wsEndpoint();
  const port = parseInt(new URL(wsEndpoint).port, 10);

  const config = {
    extends: 'lighthouse:default',
    settings: {
      formFactor: strategy === 'mobile' ? 'mobile' : 'desktop',
      screenEmulation: strategy === 'mobile'
        ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
        : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      throttlingMethod: 'simulate',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      maxWaitForLoad: 45 * 1000,
    },
  };

  const result = await lighthouse(url, { port, output: 'json', logLevel: 'error' }, config);
  const lhr = result.lhr;
  const cats = lhr.categories || {};
  const audits = lhr.audits || {};

  return {
    strategy,
    fetchedAt: new Date().toISOString(),
    scores: {
      performance: cats.performance?.score != null ? Math.round(cats.performance.score * 100) : null,
      accessibility: cats.accessibility?.score != null ? Math.round(cats.accessibility.score * 100) : null,
      bestPractices: cats['best-practices']?.score != null ? Math.round(cats['best-practices'].score * 100) : null,
      seo: cats.seo?.score != null ? Math.round(cats.seo.score * 100) : null,
    },
    metrics: {
      lcp: audits['largest-contentful-paint']?.displayValue || null,
      cls: audits['cumulative-layout-shift']?.displayValue || null,
      tbt: audits['total-blocking-time']?.displayValue || null,
      fcp: audits['first-contentful-paint']?.displayValue || null,
      speedIndex: audits['speed-index']?.displayValue || null,
    },
  };
}

async function auditUrl(url) {
  const out = { url };
  try {
    out.mobile = await runLighthouse(url, 'mobile');
  } catch (err) {
    out.mobile = { error: String(err.message).slice(0, 200) };
  }
  try {
    out.desktop = await runLighthouse(url, 'desktop');
  } catch (err) {
    out.desktop = { error: String(err.message).slice(0, 200) };
  }
  return out;
}

module.exports = { auditUrl, runLighthouse, closeBrowser };
