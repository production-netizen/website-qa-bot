const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'reports', 'test', 'Vikas Acharya.html'), 'utf8');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1.5 });
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 400));
  const handles = await page.$$('.cover, .page');
  console.log('sections:', handles.length);
  for (let i = 0; i < handles.length; i++) {
    const fp = path.join(__dirname, '..', 'reports', 'test', 'preview-' + (i + 1) + '.png');
    await handles[i].screenshot({ path: fp });
    console.log('saved', fp);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
