require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const { loadClients } = require('./lib/sheet');
const { auditClient, persistAudit } = require('./lib/audit');
// runSingleUrl is defined below; needs auditClient + persistAudit imports above
const { closeBrowser: closeLhBrowser } = require('./lib/lighthouse');
const { closeBrowser: closeVisionBrowser } = require('./lib/vision');
const { closeBrowser: closePdfBrowser } = require('./lib/pdf');
const { postSummary } = require('./lib/discord');
const { startListener } = require('./lib/discord-listener');

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
      const audit = await auditClient(client, { log: logLine });
      const { summary } = await persistAudit(audit, { reportsDir: REPORTS_DIR, log: logLine });
      summaries.push(summary);
      logLine(`[done] ${client.name} — score=${summary.healthScore} flags=${summary.flagCount}`);
      persistPartial();
    } catch (err) {
      errors.push(`${client.name}: ${err.message}`);
      logLine(`[error] ${client.name}: ${err.message}`);
      persistPartial();
    }
  }, concurrency);

  await Promise.all([
    closeVisionBrowser().catch(() => {}),
    closeLhBrowser().catch(() => {}),
    closePdfBrowser().catch(() => {}),
  ]);

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
  logLine(`[boot] daily audit scheduled for "${expr}" (${tz})`);

  // Discord on-demand listener — disabled by default because production-bot
  // already owns DISCORD_TOKEN; we'd fight it. Set QA_ENABLE_LISTENER=1 only
  // if running with a dedicated bot token.
  if (process.env.QA_ENABLE_LISTENER === '1') {
    startListener({ reportsDir: REPORTS_DIR, log: logLine });
  } else {
    logLine('[boot] Discord listener disabled (production-bot handles on-demand triggers via subprocess)');
  }
}

// ─── Single-URL audit (called as subprocess by production-bot) ─────────
// Usage: node bot.js --url="https://example.com" [--name="Display Name"]
// Prints a single JSON line to stdout: { ok, summary, pdfPath, pdfLink, driveLink }
async function runSingleUrl(url, displayName) {
  ensureDir(DATA_DIR);
  ensureDir(REPORTS_DIR);
  const name = displayName || (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();
  const client = { name, url, status: 'On-demand', developer: '', team: '', notes: '' };

  const audit = await auditClient(client, {
    maxPages: parseInt(process.env.QA_ONDEMAND_MAX_PAGES || '3', 10),
    maxVisionPages: parseInt(process.env.QA_ONDEMAND_VISION_PAGES || '1', 10),
    log: logLine,
  });

  const { summary, pdfLink, driveLink, localPdfPath } = await persistAudit(audit, { reportsDir: REPORTS_DIR, log: logLine });

  await Promise.all([
    closeVisionBrowser().catch(() => {}),
    closeLhBrowser().catch(() => {}),
    closePdfBrowser().catch(() => {}),
  ]);

  return { ok: true, summary, pdfPath: localPdfPath, pdfLink, driveLink };
}

process.on('uncaughtException', (err) => {
  logLine(`[fatal] uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (err) => {
  logLine(`[fatal] unhandledRejection: ${err && (err.stack || err.message) || err}`);
});

function parseArgs() {
  const args = { once: false, clientFilter: null, url: null, name: null };
  for (const a of process.argv.slice(2)) {
    if (a === '--once') args.once = true;
    else if (a.startsWith('--client=')) args.clientFilter = a.slice('--client='.length).replace(/^["']|["']$/g, '');
    else if (a.startsWith('--url=')) args.url = a.slice('--url='.length).replace(/^["']|["']$/g, '');
    else if (a.startsWith('--name=')) args.name = a.slice('--name='.length).replace(/^["']|["']$/g, '');
  }
  return args;
}

if (require.main === module) {
  const args = parseArgs();
  if (args.url) {
    // Single-URL on-demand mode (called by production-bot)
    runSingleUrl(args.url, args.name)
      .then((result) => {
        // Single JSON line on stdout — production-bot parses this
        console.log('__AUDIT_RESULT__' + JSON.stringify(result));
        process.exit(0);
      })
      .catch(async (err) => {
        console.log('__AUDIT_RESULT__' + JSON.stringify({ ok: false, error: err.message }));
        await Promise.all([
          closeVisionBrowser().catch(() => {}),
          closeLhBrowser().catch(() => {}),
          closePdfBrowser().catch(() => {}),
        ]);
        process.exit(1);
      });
  } else if (args.once) {
    runOnce({ clientFilter: args.clientFilter })
      .then(async () => {
        await Promise.all([
          closeVisionBrowser().catch(() => {}),
          closeLhBrowser().catch(() => {}),
          closePdfBrowser().catch(() => {}),
        ]);
        process.exit(0);
      })
      .catch(async (err) => {
        logLine(`[fatal] runOnce: ${err.stack || err.message}`);
        await Promise.all([
          closeVisionBrowser().catch(() => {}),
          closeLhBrowser().catch(() => {}),
          closePdfBrowser().catch(() => {}),
        ]);
        process.exit(1);
      });
  } else {
    startCron();
  }
}

module.exports = { runOnce };
