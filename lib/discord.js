const fetch = require('node-fetch');

function rankSeverity(s) {
  const flags = s.flagCount || 0;
  const perfMin = Math.min(s.perfMobile ?? 100, s.perfDesktop ?? 100);
  let score = 0;
  if (perfMin < 50) score += 50;
  else if (perfMin < 70) score += 25;
  else if (perfMin < 90) score += 10;
  score += Math.min(flags * 2, 60);
  return score;
}

function bucket(s) {
  const sev = rankSeverity(s);
  if (sev >= 60) return 'critical';
  if (sev >= 25) return 'medium';
  return 'ok';
}

function emoji(b) {
  return b === 'critical' ? '🔴' : b === 'medium' ? '🟡' : '🟢';
}

function summaryLine(s, b, link) {
  const perf = `m${s.perfMobile ?? '—'}/d${s.perfDesktop ?? '—'}`;
  const linkPart = link ? `[report](${link})` : '_no report link_';
  return `${emoji(b)} **${s.name}** — perf ${perf}, ${s.flagCount} flag${s.flagCount === 1 ? '' : 's'} · ${linkPart}`;
}

async function postSummary({ webhookUrl, runAt, summaries, errors }) {
  if (!webhookUrl) {
    console.warn('No WEBSITE_AUDITS_WEBHOOK_URL set — skipping Discord post');
    return;
  }

  const buckets = { critical: [], medium: [], ok: [] };
  for (const s of summaries) buckets[bucket(s)].push(s);

  const lines = [];
  lines.push(`### 🔍 Daily Website Audit — ${runAt}`);
  lines.push(`Audited **${summaries.length}** sites · 🔴 ${buckets.critical.length} critical · 🟡 ${buckets.medium.length} need work · 🟢 ${buckets.ok.length} clean`);
  lines.push('');

  if (buckets.critical.length) {
    lines.push('**🔴 Critical**');
    buckets.critical.forEach((s) => lines.push(summaryLine(s, 'critical', s.reportLink)));
    lines.push('');
  }
  if (buckets.medium.length) {
    lines.push('**🟡 Needs work**');
    buckets.medium.slice(0, 15).forEach((s) => lines.push(summaryLine(s, 'medium', s.reportLink)));
    if (buckets.medium.length > 15) lines.push(`_…and ${buckets.medium.length - 15} more_`);
    lines.push('');
  }
  if (buckets.ok.length) {
    lines.push(`**🟢 Clean (${buckets.ok.length}):** ${buckets.ok.slice(0, 20).map((s) => s.name).join(', ')}${buckets.ok.length > 20 ? '…' : ''}`);
  }

  if (errors && errors.length) {
    lines.push('');
    lines.push(`_Errors: ${errors.length}_ — see full report folder.`);
  }

  const content = lines.join('\n').slice(0, 1900);

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'Website QA Bot', content }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Discord webhook failed ${res.status}: ${txt.slice(0, 200)}`);
  }
}

module.exports = { postSummary };
