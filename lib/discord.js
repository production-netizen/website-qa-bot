const fetch = require('node-fetch');

// ────────────────────────────────────────────────────────────────────────
// Bucketing — based on overall health score (more accurate than flag count)
// ────────────────────────────────────────────────────────────────────────

function bucket(s) {
  const score = s.healthScore;
  if (score == null) return 'unknown';
  if (score < 55) return 'critical';
  if (score < 75) return 'medium';
  return 'ok';
}

function emoji(b) {
  return b === 'critical' ? '🔴' : b === 'medium' ? '🟡' : b === 'ok' ? '🟢' : '⚪️';
}

function gradeBadge(s) {
  if (s.healthScore == null) return '⚪️ —';
  return `**${s.healthScore}/100** (${s.healthGrade})`;
}

function summaryLine(s, b, link) {
  const perf = `m${s.perfMobile ?? '—'}/d${s.perfDesktop ?? '—'}`;
  const linkPart = link ? `[report](${link})` : '_no report link_';
  return `${emoji(b)} **${s.name}** — ${gradeBadge(s)} · perf ${perf} · ${s.high} high / ${s.medium} med · ${linkPart}`;
}

function topFixesBlock(s) {
  if (!s.topFixes || s.topFixes.length === 0) return '';
  const lines = s.topFixes.map((f, i) => {
    const sevEmoji = f.severity === 'high' ? '🔴' : f.severity === 'medium' ? '🟡' : '🟢';
    // Trim long flags so the Discord message fits 2k chars
    const trimmed = f.flag.length > 90 ? f.flag.slice(0, 87) + '…' : f.flag;
    return `   ${i + 1}. ${sevEmoji} ${trimmed} _(${f.where})_`;
  });
  return lines.join('\n');
}

async function postSummary({ webhookUrl, runAt, summaries, errors }) {
  if (!webhookUrl) {
    console.warn('No WEBSITE_AUDITS_WEBHOOK_URL set — skipping Discord post');
    return;
  }

  const buckets = { critical: [], medium: [], ok: [], unknown: [] };
  for (const s of summaries) buckets[bucket(s)].push(s);

  // Sort within each bucket by health score ascending (worst first)
  for (const b of Object.keys(buckets)) {
    buckets[b].sort((a, c) => (a.healthScore ?? 0) - (c.healthScore ?? 0));
  }

  // ─── First message: header + critical (with top fixes inline) ───
  const headerLines = [];
  headerLines.push(`### 🔍 Daily Website Audit — ${runAt}`);
  headerLines.push(`Audited **${summaries.length}** sites · 🔴 ${buckets.critical.length} critical · 🟡 ${buckets.medium.length} need work · 🟢 ${buckets.ok.length} healthy`);
  headerLines.push('');

  if (buckets.critical.length) {
    headerLines.push('**🔴 Critical — fix this week**');
    for (const s of buckets.critical) {
      headerLines.push(summaryLine(s, 'critical', s.reportLink));
      const fixes = topFixesBlock(s);
      if (fixes) headerLines.push(fixes);
    }
    headerLines.push('');
  }

  // ─── Second message: medium + ok + errors ───
  const tailLines = [];
  if (buckets.medium.length) {
    tailLines.push('**🟡 Needs work**');
    for (const s of buckets.medium.slice(0, 15)) {
      tailLines.push(summaryLine(s, 'medium', s.reportLink));
    }
    if (buckets.medium.length > 15) tailLines.push(`_…and ${buckets.medium.length - 15} more_`);
    tailLines.push('');
  }
  if (buckets.ok.length) {
    tailLines.push(`**🟢 Healthy (${buckets.ok.length}):** ${buckets.ok.slice(0, 25).map((s) => `${s.name} (${s.healthScore})`).join(', ')}${buckets.ok.length > 25 ? '…' : ''}`);
  }
  if (errors && errors.length) {
    tailLines.push('');
    tailLines.push(`_Errors: ${errors.length}_ — see full report folder.`);
  }

  // Post in 1-2 messages so we don't truncate critical findings
  const post = async (content) => {
    if (!content.trim()) return;
    const body = JSON.stringify({ username: 'Website QA Bot', content: content.slice(0, 1990) });
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Discord webhook failed ${res.status}: ${txt.slice(0, 200)}`);
    }
  };

  await post(headerLines.join('\n'));
  if (tailLines.length) await post(tailLines.join('\n'));
}

module.exports = { postSummary };
