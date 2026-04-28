const Anthropic = require('@anthropic-ai/sdk');
const puppeteer = require('puppeteer');

let browser = null;
let anthropic = null;

function getAnthropic() {
  if (anthropic) return anthropic;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

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

async function screenshotViewport(page, width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise((r) => setTimeout(r, 800));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 400));
  return page.screenshot({ type: 'jpeg', quality: 60, fullPage: true, encoding: 'base64' });
}

async function captureViewports(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultNavigationTimeout(60 * 1000);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60 * 1000 }).catch(async (e) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30 * 1000 });
  });
  const desktop = await screenshotViewport(page, 1440, 900);
  const mobile = await screenshotViewport(page, 390, 844);
  await page.close();
  return { desktop, mobile };
}

const VISION_SYSTEM = `You are a senior CRO + UX QA reviewer for UK medical-clinic websites. You inherit the heuristic frameworks from André Morys (7 Levels of Conversion) and Michael Aagaard (Landing Page Optimization). You receive desktop + mobile screenshots of a single page. Identify CONCRETE, OBSERVABLE defects only — never speculate.

Apply this lens to each screenshot:

🚧 BROKEN / TECHNICAL (severity=high)
- Overlapping elements, sections clipped, blown-out images, mis-aligned grids
- Mobile horizontal scroll, off-screen content, broken hamburger menu, illegible text
- Placeholder content: "Lorem ipsum", "Your text here", "Sample heading", default WordPress theme images, broken image icons

🎯 CLARITY & RELEVANCE (severity=high if hero, medium otherwise)
- Hero section: is the value proposition obvious in <5 seconds? What does this clinic do, for whom?
- Single primary CTA above the fold? Or multiple competing CTAs?
- Headline matches the search intent? (e.g. "Knee Surgery Specialist" page should lead with that, not generic welcome)

📞 CONVERSION FRICTION (severity=high)
- No visible phone number / booking button in header
- Long contact form when a tel: tap-to-call would convert better
- CTA buried below fold or too small / wrong contrast

🛡️ TRUST & CREDIBILITY (severity=medium)
- No testimonials / patient reviews / Google review count visible above fold
- No GMC number, NHS affiliation, professional body badges
- No before/after, case studies, or specialty credentials visible
- Awards / press logos missing

🎨 DESIGN CONSISTENCY (severity=medium)
- Inconsistent spacing, padding, gutters between sections
- Mismatched font sizes, awkward line-breaks, orphan words
- Color clashes, text on busy backgrounds, low-contrast buttons

🪜 INFORMATION ARCHITECTURE (severity=medium/low)
- Navigation hidden on mobile or unclear hierarchy
- No clear next step from this page (dead-end)

Respond ONLY in this JSON format (no prose outside JSON):
{"summary": "one-line overall verdict", "issues": [{"severity": "high|medium|low", "viewport": "desktop|mobile|both", "category": "broken|clarity|friction|trust|design|navigation", "issue": "concrete description", "fix": "one-line concrete recommendation"}]}

If clean, return {"summary": "Clean — no obvious defects", "issues": []}. Be terse but specific. No flattery.`;

async function reviewPage({ url, desktopB64, mobileB64, model }) {
  const client = getAnthropic();
  if (!client) return { skipped: 'no ANTHROPIC_API_KEY' };
  const useModel = model || process.env.QA_VISION_MODEL || 'claude-haiku-4-5-20251001';

  const message = await client.messages.create({
    model: useModel,
    max_tokens: 1024,
    system: VISION_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `Page: ${url}\n\nDesktop screenshot:` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: desktopB64 } },
        { type: 'text', text: 'Mobile screenshot:' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: mobileB64 } },
        { type: 'text', text: 'Now produce the JSON verdict.' },
      ],
    }],
  });

  const raw = message.content?.find((b) => b.type === 'text')?.text || '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { summary: 'Unparseable vision response', issues: [], raw };
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { summary: parsed.summary || '', issues: parsed.issues || [] };
  } catch (err) {
    return { summary: 'Unparseable vision response', issues: [], raw };
  }
}

async function visionAuditUrl(url) {
  try {
    const { desktop, mobile } = await captureViewports(url);
    return await reviewPage({ url, desktopB64: desktop, mobileB64: mobile });
  } catch (err) {
    return { error: String(err.message).slice(0, 200) };
  }
}

module.exports = { visionAuditUrl, captureViewports, reviewPage, closeBrowser };
