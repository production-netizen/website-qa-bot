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
const MAX_LOG_BYTES = 100 * 1024 * 1024; // 100MB cap; rotated to bot.log.1
function logLine(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  // Never throw out of logLine — a throw here would re-enter uncaughtException → infinite loop.
  try { process.stdout.write(line + '\n'); } catch (_) {}
  try {
    ensureDir(DATA_DIR);
    const logPath = path.join(DATA_DIR, 'bot.log');
    try {
      const st = fs.statSync(logPath);
      if (st.size > MAX_LOG_BYTES) {
        try { fs.renameSync(logPath, logPath + '.1'); } catch (_) {}
      }
    } catch (_) {}
    fs.appendFileSync(logPath, line + '\n');
  } catch (_) {}
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

// Levenshtein edit distance (small inputs, fine without optimisation)
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[a.length][b.length];
}

// Tolerant fuzzy match — handles typos in either the query or the sheet
// (e.g. sheet has "Phadinis" but user types "Phadnis"). Each query token
// must substring-match a name token OR be within edit distance ≤ 2 (longer
// tokens get up to ≤ 3) of any name token.
function fuzzyMatchClients(clients, query) {
  if (!query) return clients;
  const q = query.trim().toLowerCase();
  if (!q) return clients;
  const queryTokens = q.split(/\s+/).filter(Boolean);
  const tokenMatches = (qTok, nameTokens) => {
    if (qTok.length <= 2) return nameTokens.some((nt) => nt.startsWith(qTok));
    if (nameTokens.some((nt) => nt.includes(qTok) || qTok.includes(nt))) return true;
    const allowed = qTok.length >= 8 ? 3 : qTok.length >= 5 ? 2 : 1;
    return nameTokens.some((nt) => editDistance(qTok, nt) <= allowed);
  };
  return clients.filter((c) => {
    const name = c.name.toLowerCase();
    const nameTokens = name.split(/\s+/).filter(Boolean);
    if (name.includes(q)) return true;
    return queryTokens.every((t) => tokenMatches(t, nameTokens));
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

// Use process.stderr directly so a failing logLine cannot retrigger this
// handler and cause the EIO-loop that filled the disk on 2026-05-03.
process.on('uncaughtException', (err) => {
  try { process.stderr.write(`[fatal] uncaughtException: ${err && (err.stack || err.message) || err}\n`); } catch (_) {}
});
process.on('unhandledRejection', (err) => {
  try { process.stderr.write(`[fatal] unhandledRejection: ${err && (err.stack || err.message) || err}\n`); } catch (_) {}
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

module.exports = { runOnce, runSingleUrl };
