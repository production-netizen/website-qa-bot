require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const { loadClients } = require('./lib/sheet');
const { discoverPages } = require('./lib/crawl');
const { auditUrl: lighthouseAudit, closeBrowser: closeLhBrowser } = require('./lib/lighthouse');
const { analyseUrl } = require('./lib/seo');
const { fetchHtml } = require('./lib/seo');
const { auditPageImages } = require('./lib/images');
const { visionAuditUrl, closeBrowser: closeVisionBrowser } = require('./lib/vision');
const { buildClientMarkdown, summariseClient, saveReportToDrive, saveLocalReport } = require('./lib/report');
const { postSummary } = require('./lib/discord');

const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_DIR = path.join(__dirname, 'reports');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function logLine(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  ensureDir(DATA_DIR);
  fs.appendFileSync(path.join(DATA_DIR, 'bot.log'), line + '\n');
}

async function pMap(items, mapper, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await mapper(items[i], i); }
      catch (err) { results[i] = { error: String(err.message || err).slice(0, 300) }; }
    }
  }
  const workers = Array(Math.min(concurrency, items.length)).fill(0).map(() => worker());
  await Promise.all(workers);
  return results;
}

async function auditPage(url, { runVision }) {
  const out = { url, errors: [] };
  try {
    const seo = await analyseUrl(url);
    out.seo = seo;
    if (seo.error) out.errors.push(`seo: ${seo.error}`);

    const { html } = await fetchHtml(url).catch(() => ({ html: '' }));
    if (html) {
      out.images = auditPageImages(html, url);
    }
  } catch (err) {
    out.errors.push(`seo-fetch: ${err.message}`.slice(0, 200));
  }
  if (runVision) {
    try {
      out.vision = await visionAuditUrl(url);
    } catch (err) {
      out.vision = { error: String(err.message).slice(0, 200) };
    }
  }
  return out;
}

async function auditClient(client) {
  const runAt = new Date().toISOString();
  logLine(`[client] ${client.name} → ${client.url}`);
  const audit = { client, runAt, pages: [], errors: [] };

  const maxPages = parseInt(process.env.QA_MAX_PAGES_PER_SITE || '5', 10);
  const maxVisionPages = parseInt(process.env.QA_MAX_PAGES_FOR_VISION || '2', 10);

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

async function persistAudit(audit) {
  const folderId = process.env.REPORTS_DRIVE_FOLDER_ID;
  const date = new Date().toISOString().slice(0, 10);
  const safeName = audit.client.name.replace(/[\\/:"*?<>|]+/g, '-').trim();
  const fileName = `${safeName} — Website QA — ${date}`;
  const md = buildClientMarkdown(audit.client, audit);

  const dailyDir = path.join(REPORTS_DIR, date);
  saveLocalReport({ md, fileName: `${safeName}.md`, dir: dailyDir });

  let driveLink = null;
  if (folderId) {
    try {
      const file = await saveReportToDrive({ md, fileName, parentFolderId: folderId });
      driveLink = file.webViewLink || null;
    } catch (err) {
      logLine(`[drive] save failed for ${audit.client.name}: ${err.message}`);
    }
  }
  return { driveLink };
}

function fuzzyMatchClients(clients, query) {
  if (!query) return clients;
  const q = query.trim().toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return clients.filter((c) => {
    const name = c.name.toLowerCase();
    return tokens.every((t) => name.includes(t));
  });
}

async function runOnce({ clientFilter = null } = {}) {
  const runAt = new Date().toISOString();
  logLine(`=== Website QA run starting at ${runAt} ===`);
  ensureDir(DATA_DIR);
  ensureDir(REPORTS_DIR);

  const statusFilter = clientFilter
    ? (process.env.QA_STATUS_FILTER || 'Live') + ',Staging'
    : (process.env.QA_STATUS_FILTER || 'Live');
  const concurrency = parseInt(process.env.QA_CONCURRENCY || '4', 10);

  let clients = await loadClients({ statusFilter });
  if (clientFilter) {
    const matched = fuzzyMatchClients(clients, clientFilter);
    if (matched.length === 0) {
      logLine(`[run] no client matched "${clientFilter}" — aborting`);
      return { summaries: [], errors: [`No client matched "${clientFilter}"`], matchAmbiguous: null };
    }
    if (matched.length > 1) {
      logLine(`[run] "${clientFilter}" matched ${matched.length} clients: ${matched.map((c) => c.name).join(', ')} — running all of them`);
    }
    clients = matched;
  }
  logLine(`[run] loaded ${clients.length} clients (filter=${statusFilter}${clientFilter ? `, name="${clientFilter}"` : ''})`);

  const summaries = [];
  const errors = [];

  const partialPath = path.join(DATA_DIR, `summary-${runAt.slice(0, 10)}.json`);
  const persistPartial = () => {
    try { fs.writeFileSync(partialPath, JSON.stringify({ runAt, summaries, errors, partial: true }, null, 2)); }
    catch {}
  };

  await pMap(clients, async (client) => {
    try {
      const audit = await auditClient(client);
      const { driveLink } = await persistAudit(audit);
      const summary = summariseClient(client, audit);
      summary.reportLink = driveLink;
      summaries.push(summary);
      logLine(`[done] ${client.name} — flags=${summary.flagCount}`);
      persistPartial();
    } catch (err) {
      errors.push(`${client.name}: ${err.message}`);
      logLine(`[error] ${client.name}: ${err.message}`);
      persistPartial();
    }
  }, concurrency);

  await Promise.all([closeVisionBrowser().catch(() => {}), closeLhBrowser().catch(() => {})]);

  fs.writeFileSync(partialPath, JSON.stringify({ runAt, summaries, errors, partial: false }, null, 2));

  try {
    await postSummary({
      webhookUrl: process.env.WEBSITE_AUDITS_WEBHOOK_URL,
      runAt: runAt.slice(0, 16).replace('T', ' '),
      summaries,
      errors,
    });
  } catch (err) {
    logLine(`[discord] post failed: ${err.message}`);
  }

  logLine(`=== run complete: ${summaries.length} ok, ${errors.length} errors ===`);
  return { summaries, errors };
}

function startCron() {
  const expr = process.env.QA_DAILY_CRON || '0 6 * * *';
  const tz = process.env.QA_TIMEZONE || 'Asia/Kolkata';
  cron.schedule(expr, () => {
    runOnce().catch((err) => logLine(`[cron] run failed: ${err.message}`));
  }, { timezone: tz });
  logLine(`[boot] website-qa-bot online — daily run at "${expr}" (${tz})`);
}

process.on('uncaughtException', (err) => {
  logLine(`[fatal] uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  logLine(`[fatal] unhandledRejection: ${err && (err.stack || err.message) || err}`);
});

function parseArgs() {
  const args = { once: false, clientFilter: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--once') args.once = true;
    else if (a.startsWith('--client=')) args.clientFilter = a.slice('--client='.length).replace(/^["']|["']$/g, '');
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs();
  if (args.once) {
    runOnce({ clientFilter: args.clientFilter })
      .then(async () => {
        await Promise.all([closeVisionBrowser().catch(() => {}), closeLhBrowser().catch(() => {})]);
        process.exit(0);
      })
      .catch(async (err) => {
        logLine(`[fatal] runOnce: ${err.stack || err.message}`);
        await Promise.all([closeVisionBrowser().catch(() => {}), closeLhBrowser().catch(() => {})]);
        process.exit(1);
      });
  } else {
    startCron();
  }
}

module.exports = { runOnce };
