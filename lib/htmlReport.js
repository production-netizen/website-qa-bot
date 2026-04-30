// Renders a beautifully styled HTML version of a client audit.
// This HTML is intended to be rendered to PDF via Puppeteer (lib/pdf.js)
// for client-facing reports. Inline CSS only (no external assets) so the
// PDF render is reproducible offline.

const { siteScore } = require('./score');
const { checkSiteStrengths } = require('./strengths');
const { enrichFlag } = require('./issueLibrary');

// ─── Helpers (mirrors of report.js but for HTML) ───────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const sevColor = (sev) => sev === 'high' ? '#EF4444' : sev === 'medium' ? '#F59E0B' : '#10B981';
const sevLabel = (sev) => sev === 'high' ? 'HIGH IMPACT' : sev === 'medium' ? 'MEDIUM IMPACT' : 'LOW IMPACT';
const sevBadgeBg = (sev) => sev === 'high' ? '#FEE2E2' : sev === 'medium' ? '#FEF3C7' : '#D1FAE5';
const sevBadgeFg = (sev) => sev === 'high' ? '#991B1B' : sev === 'medium' ? '#92400E' : '#065F46';

const trackPill = (track) => track === 'dev'
  ? '<span class="pill pill-dev">🛠️ Development team</span>'
  : '<span class="pill pill-mkt">✍️ Marketing / CSM</span>';

function pageLabel(client, page) {
  if (page.url === client.url) return 'Homepage';
  try { return new URL(page.url).pathname || page.url; } catch { return page.url; }
}

function legacySeverity(flag) {
  const f = String(flag).toLowerCase();
  if (/^http \d|missing <title>|no <h1>|missing <meta name="viewport"|no <form>|no conversion path|no booking\/appointment cta|no styled cta buttons|critically low|seo low|accessibility low/.test(f)) return 'high';
  if (/multiple <h1>|title too short|title too long|meta description too|missing meta description|no "privacy policy"|no "terms"|no "cookie policy"|footer does not contain|no gtm container|missing <link rel="canonical|no json-ld|missing <html lang|no clickable phone|no social proof|no medical or local-business schema|many competing ctas|no gmc number|stock host|stock filename|long contact form|poor url slug|performance low|accessibility below|seo below|best practices low/.test(f)) return 'medium';
  return 'low';
}

function buildLighthouseFlags(audit) {
  const out = [];
  for (const strategy of ['mobile', 'desktop']) {
    const s = audit?.lighthouse?.[strategy]?.scores;
    if (!s) continue;
    const label = strategy === 'mobile' ? 'Mobile' : 'Desktop';
    if (s.performance != null && s.performance < 50) out.push(`${label} Performance critically low: ${s.performance}/100`);
    else if (s.performance != null && s.performance < 70) out.push(`${label} Performance low: ${s.performance}/100`);
    if (s.accessibility != null && s.accessibility < 70) out.push(`${label} Accessibility low: ${s.accessibility}/100`);
    else if (s.accessibility != null && s.accessibility < 90) out.push(`${label} Accessibility below target: ${s.accessibility}/100`);
    if (s.seo != null && s.seo < 70) out.push(`${label} SEO low: ${s.seo}/100`);
    else if (s.seo != null && s.seo < 90) out.push(`${label} SEO below target: ${s.seo}/100`);
    if (s.bestPractices != null && s.bestPractices < 80) out.push(`${label} Best Practices low: ${s.bestPractices}/100`);
  }
  return out;
}

function gatherIssues(client, audit) {
  const issues = [];
  for (const lhFlag of buildLighthouseFlags(audit)) {
    const e = enrichFlag(lhFlag, legacySeverity(lhFlag));
    issues.push({ where: 'Site (Lighthouse)', ...e });
  }
  for (const page of audit.pages || []) {
    const where = pageLabel(client, page);
    for (const flag of (page.seo?.flags || [])) {
      const e = enrichFlag(flag, legacySeverity(flag));
      issues.push({ where, ...e });
    }
    for (const img of (page.images?.flagged || [])) {
      for (const f of (img.flags || [])) {
        const e = enrichFlag(f, legacySeverity(f));
        issues.push({ where, ...e });
      }
    }
    for (const v of (page.vision?.issues || [])) {
      const sev = (v.severity || '').toLowerCase();
      const fallback = sev === 'critical' ? 'high' : (sev === 'high' || sev === 'medium' || sev === 'low') ? sev : 'medium';
      issues.push({
        where,
        severity: fallback,
        track: v.category === 'broken' ? 'dev' : 'marketing',
        rootCause: `Visual review (${v.viewport || 'both'} viewport): ${v.issue}`,
        howToFix: v.fix || 'Investigate the highlighted element and apply layout / spacing fixes.',
        businessImpact: 'Layout problems erode trust and increase bounce. Mobile-break issues especially.',
        flag: v.issue,
      });
    }
  }
  return issues;
}

function groupIssues(issues) {
  const keyOf = (i) => {
    let s = String(i.flag || '').toLowerCase();
    s = s.replace(/\(\d+ chars/g, '(N chars').replace(/: \d+\/100/g, ': N/100').replace(/\(\d+ buttons/g, '(N buttons');
    s = s.replace(/"[^"]*"/g, '"…"');
    s = s.replace(/^stock filename:\s*\S+/i, 'stock filename: <name>');
    s = s.replace(/^missing alt:\s*\S+/i, 'missing alt: <file>');
    s = s.replace(/^stock host:\s*\S+/i, 'stock host: <host>');
    return `${i.severity || 'low'}|${i.track}|${s.slice(0, 120)}`;
  };
  const groups = new Map();
  for (const issue of issues) {
    const k = keyOf(issue);
    if (!groups.has(k)) groups.set(k, { ...issue, wheres: new Set([issue.where]), examples: [issue.flag] });
    else { const g = groups.get(k); g.wheres.add(issue.where); if (g.examples.length < 3) g.examples.push(issue.flag); }
  }
  return [...groups.values()].map((g) => ({ ...g, wheres: [...g.wheres], occurrences: g.wheres.size }));
}

function pickTopFixes(issues, n = 3) {
  const grouped = groupIssues(issues);
  return grouped.sort((a, b) => {
    const r = { high: 0, medium: 1, low: 2 };
    if (r[a.severity] !== r[b.severity]) return r[a.severity] - r[b.severity];
    if (b.occurrences !== a.occurrences) return b.occurrences - a.occurrences;
    return a.track === 'marketing' ? -1 : 1;
  }).slice(0, n);
}

// ─── Score gauge (SVG arc) ─────────────────────────────────────────────

function scoreGauge(score, grade, status) {
  const r = 80;
  const cx = 100; const cy = 100;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const dashArray = `${pct * circ} ${circ}`;
  const color = score >= 80 ? '#10B981' : score >= 65 ? '#F59E0B' : score >= 50 ? '#FB923C' : '#EF4444';
  return `
  <svg width="200" height="200" viewBox="0 0 200 200">
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke="#E5E7EB" stroke-width="14" fill="none"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke="${color}" stroke-width="14" fill="none"
      stroke-dasharray="${dashArray}" stroke-linecap="round"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="44" font-weight="800" fill="#0F172A" font-family="Inter, system-ui, sans-serif">${score}</text>
    <text x="${cx}" y="${cy + 25}" text-anchor="middle" font-size="13" font-weight="600" fill="#64748B" letter-spacing="1.5" font-family="Inter, system-ui, sans-serif">GRADE ${grade}</text>
  </svg>`;
}

function miniBar(score) {
  if (score == null) return '<div class="bar-track"><div class="bar-fill" style="width:0%;background:#CBD5E1"></div></div><span class="bar-text">—</span>';
  const color = score >= 90 ? '#10B981' : score >= 70 ? '#F59E0B' : score >= 50 ? '#FB923C' : '#EF4444';
  return `<div class="bar-track"><div class="bar-fill" style="width:${score}%;background:${color}"></div></div><span class="bar-text">${score}</span>`;
}

const STYLES = `
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: 'Inter', system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #0F172A; background: #FFFFFF;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    font-size: 11.5pt; line-height: 1.5;
  }
  h1, h2, h3, h4 { margin: 0; font-weight: 700; letter-spacing: -0.01em; }
  h2 { font-size: 22pt; margin: 0 0 14pt; color: #0F172A; }
  h3 { font-size: 14pt; margin: 14pt 0 8pt; color: #0F172A; }
  h4 { font-size: 12pt; margin: 10pt 0 6pt; color: #1E293B; }
  p { margin: 0 0 8pt; }
  a { color: #2563EB; text-decoration: none; }
  table { width: 100%; border-collapse: collapse; }

  /* Page wrapper — adds margin only on non-cover pages */
  .page {
    page-break-after: always; break-after: page;
    padding: 28mm 22mm 26mm;
    min-height: 297mm;
    position: relative;
  }
  .page:last-child { page-break-after: auto; }

  /* Brand strip top-left */
  .brand-strip {
    position: absolute;
    top: 0; left: 0; right: 0; height: 6mm;
    background: linear-gradient(90deg, #0F172A 0%, #1E40AF 50%, #0EA5E9 100%);
  }
  .footer {
    position: absolute;
    bottom: 12mm; left: 22mm; right: 22mm;
    font-size: 8.5pt; color: #94A3B8;
    display: flex; justify-content: space-between;
    border-top: 1px solid #E2E8F0; padding-top: 6pt;
  }

  /* ─── COVER PAGE ─── */
  .cover {
    page-break-after: always; break-after: page;
    padding: 0; margin: 0; height: 297mm; width: 210mm;
    background: linear-gradient(155deg, #0F172A 0%, #1E3A8A 50%, #0EA5E9 100%);
    color: #FFFFFF;
    position: relative; overflow: hidden;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 30mm 22mm;
  }
  .cover::before {
    content: ''; position: absolute; top: -100mm; right: -50mm; width: 200mm; height: 200mm;
    background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%);
    border-radius: 50%;
  }
  .cover::after {
    content: ''; position: absolute; bottom: -60mm; left: -30mm; width: 150mm; height: 150mm;
    background: radial-gradient(circle, rgba(14,165,233,0.15) 0%, transparent 70%);
    border-radius: 50%;
  }
  .cover-brand { font-size: 11pt; letter-spacing: 4px; text-transform: uppercase; color: rgba(255,255,255,0.7); font-weight: 600; }
  .cover-title { font-size: 38pt; font-weight: 800; margin-top: 8mm; line-height: 1.1; max-width: 110mm; }
  .cover-subtitle { font-size: 13pt; color: rgba(255,255,255,0.85); margin-top: 6mm; max-width: 110mm; line-height: 1.5; }
  .cover-meta {
    margin-top: auto; display: flex; gap: 14mm; align-items: flex-end;
    border-top: 1px solid rgba(255,255,255,0.2); padding-top: 8mm;
  }
  .cover-meta-block { font-size: 10pt; }
  .cover-meta-label { color: rgba(255,255,255,0.6); text-transform: uppercase; letter-spacing: 1.5px; font-size: 8.5pt; }
  .cover-meta-value { color: #FFFFFF; font-size: 12pt; font-weight: 600; margin-top: 2mm; }
  .cover-score {
    position: absolute; top: 30mm; right: 22mm;
    background: rgba(255,255,255,0.95); border-radius: 16pt;
    padding: 14pt 18pt; color: #0F172A;
    box-shadow: 0 20px 40px rgba(0,0,0,0.25);
  }
  .cover-score-label { font-size: 8.5pt; color: #64748B; text-transform: uppercase; letter-spacing: 1.5px; font-weight: 600; }
  .cover-score-num { font-size: 56pt; font-weight: 800; line-height: 1; margin-top: 2mm; }
  .cover-score-status { font-size: 11pt; color: #475569; font-weight: 500; margin-top: 1mm; }
  .cover-score-grade {
    display: inline-block;
    margin-top: 4mm; padding: 4pt 10pt;
    border-radius: 999px; font-size: 10pt; font-weight: 700;
  }

  /* ─── COMPONENTS ─── */

  /* Section heading bar */
  .section-eyebrow {
    display: inline-block;
    font-size: 8.5pt; color: #2563EB; font-weight: 700;
    text-transform: uppercase; letter-spacing: 2px;
    margin-bottom: 4mm;
  }
  .divider {
    height: 2px; background: linear-gradient(90deg, #2563EB 0%, transparent 100%);
    border: 0; margin: 0 0 8mm;
  }

  /* Lighthouse scoreboard */
  .lh-grid {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 4mm;
    margin: 6mm 0;
  }
  .lh-card {
    background: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 10pt;
    padding: 4mm 4mm;
  }
  .lh-card-label { font-size: 8.5pt; color: #64748B; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
  .lh-card-row { display: flex; align-items: center; gap: 3mm; margin-top: 3mm; }
  .lh-card-row span.bar-text { width: 8mm; text-align: right; font-weight: 700; font-size: 10pt; color: #0F172A; }
  .lh-card-strategy { font-size: 8pt; color: #94A3B8; width: 12mm; font-weight: 500; }
  .bar-track { flex: 1; height: 5pt; background: #E2E8F0; border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; }

  /* Top fixes */
  .top-fixes {
    background: linear-gradient(135deg, #FEF3C7 0%, #FED7AA 100%);
    border-radius: 12pt; padding: 6mm 6mm; margin: 6mm 0;
    border: 1px solid #FCD34D;
  }
  .top-fixes-title { font-size: 12pt; font-weight: 700; color: #78350F; margin-bottom: 4mm; }
  .top-fix {
    background: rgba(255,255,255,0.6); border-radius: 8pt; padding: 4mm; margin-bottom: 3mm;
    display: flex; gap: 4mm; align-items: flex-start;
  }
  .top-fix:last-child { margin-bottom: 0; }
  .top-fix-num {
    background: #92400E; color: #FFFFFF;
    width: 8mm; height: 8mm; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 11pt; flex-shrink: 0;
  }
  .top-fix-body { flex: 1; }
  .top-fix-title { font-weight: 600; color: #1F2937; font-size: 11pt; margin-bottom: 2mm; }
  .top-fix-fix { color: #4B5563; font-size: 10pt; }
  .top-fix-where { color: #92400E; font-size: 9pt; font-weight: 600; }

  /* Strengths */
  .strengths-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 3mm; }
  .strength {
    background: #ECFDF5; border-left: 3pt solid #10B981;
    padding: 3mm 4mm; border-radius: 0 6pt 6pt 0;
    font-size: 10.5pt; color: #064E3B;
  }

  /* Issue cards */
  .track-section { margin-top: 8mm; }
  .track-header {
    display: flex; align-items: center; gap: 3mm;
    padding: 3mm 4mm; background: #F1F5F9; border-radius: 8pt;
    margin-bottom: 5mm;
  }
  .track-header-icon { font-size: 14pt; }
  .track-header-text { font-weight: 700; font-size: 12pt; color: #0F172A; }
  .track-header-sub { font-size: 9.5pt; color: #64748B; }
  .severity-group-title {
    font-size: 10.5pt; font-weight: 700; color: #475569;
    text-transform: uppercase; letter-spacing: 1.5px;
    margin: 6mm 0 3mm; display: flex; align-items: center; gap: 2mm;
  }
  .severity-dot { width: 8pt; height: 8pt; border-radius: 50%; }
  .issue-card {
    border: 1px solid #E2E8F0; border-radius: 10pt; padding: 5mm;
    margin-bottom: 4mm; background: #FFFFFF;
    page-break-inside: avoid; break-inside: avoid;
    border-left: 4pt solid #94A3B8;
  }
  .issue-card.high { border-left-color: #EF4444; }
  .issue-card.medium { border-left-color: #F59E0B; }
  .issue-card.low { border-left-color: #10B981; }
  .issue-flag {
    font-weight: 700; color: #0F172A; font-size: 11.5pt;
    margin-bottom: 3mm; line-height: 1.4;
  }
  .issue-meta { display: flex; flex-wrap: wrap; gap: 3mm; margin-bottom: 4mm; }
  .pill {
    display: inline-block; padding: 1.5mm 3mm;
    border-radius: 999px; font-size: 8.5pt; font-weight: 600; letter-spacing: 0.5px;
  }
  .pill-sev-high { background: #FEE2E2; color: #991B1B; }
  .pill-sev-medium { background: #FEF3C7; color: #92400E; }
  .pill-sev-low { background: #D1FAE5; color: #065F46; }
  .pill-mkt { background: #DBEAFE; color: #1E40AF; }
  .pill-dev { background: #FCE7F3; color: #9D174D; }
  .pill-where { background: #F1F5F9; color: #475569; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
  .issue-row {
    display: grid; grid-template-columns: 28mm 1fr; gap: 3mm;
    padding: 2mm 0; border-top: 1px solid #F1F5F9;
  }
  .issue-row-label {
    font-size: 9pt; color: #64748B; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .issue-row-text { font-size: 10.5pt; color: #1E293B; line-height: 1.5; }
  .issue-pages-list {
    margin-top: 2mm;
    background: #F8FAFC; border-radius: 6pt; padding: 3mm 4mm;
    font-size: 9pt; color: #475569; max-height: 30mm; overflow: hidden;
  }
  .issue-pages-list ul { margin: 0; padding-left: 5mm; }

  /* Per-page cards */
  .page-card {
    border: 1px solid #E2E8F0; border-radius: 10pt; padding: 5mm;
    margin-bottom: 5mm; background: #FFFFFF;
    page-break-inside: avoid; break-inside: avoid;
  }
  .page-card-head {
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid #F1F5F9; padding-bottom: 3mm; margin-bottom: 4mm;
  }
  .page-card-name { font-weight: 700; font-size: 12pt; color: #0F172A; }
  .page-card-url { font-size: 9pt; color: #64748B; margin-top: 1mm; }
  .page-score-chip {
    background: #F1F5F9; padding: 2mm 4mm; border-radius: 999px;
    font-size: 14pt; font-weight: 700; color: #0F172A;
  }
  .page-score-chip.high { background: #ECFDF5; color: #047857; }
  .page-score-chip.med { background: #FEF3C7; color: #B45309; }
  .page-score-chip.low { background: #FEE2E2; color: #B91C1C; }
  .page-subscores { display: flex; gap: 5mm; margin-bottom: 4mm; flex-wrap: wrap; }
  .page-subscore {
    flex: 1; min-width: 30mm; background: #F8FAFC; padding: 3mm 4mm;
    border-radius: 6pt; border: 1px solid #E2E8F0;
  }
  .page-subscore-label { font-size: 8.5pt; color: #64748B; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .page-subscore-value { font-size: 14pt; font-weight: 700; color: #0F172A; margin-top: 1mm; }
  .page-meta-grid {
    display: grid; grid-template-columns: 28mm 1fr; gap: 2mm 4mm;
    font-size: 10pt;
  }
  .page-meta-label { color: #64748B; font-weight: 600; }
  .page-meta-value { color: #1E293B; word-break: break-word; }
  .check-row { display: flex; flex-wrap: wrap; gap: 3mm; margin-top: 2mm; }
  .check-pill {
    padding: 1.5mm 3mm; border-radius: 999px; font-size: 8.5pt; font-weight: 500;
    display: flex; align-items: center; gap: 1mm;
  }
  .check-pill.yes { background: #ECFDF5; color: #065F46; }
  .check-pill.no { background: #FEF2F2; color: #991B1B; }

  /* URL structure table */
  .url-table { font-size: 9.5pt; }
  .url-table th {
    text-align: left; padding: 3mm 3mm; background: #F8FAFC;
    color: #475569; font-weight: 700; font-size: 9pt;
    text-transform: uppercase; letter-spacing: 0.5px;
    border-bottom: 2px solid #E2E8F0;
  }
  .url-table td {
    padding: 2.5mm 3mm; border-bottom: 1px solid #F1F5F9;
    color: #1E293B;
  }
  .url-table .yes { color: #059669; font-weight: 700; }
  .url-table .no { color: #DC2626; font-weight: 700; }
  .grade-pill {
    display: inline-block; padding: 0.5mm 2mm; border-radius: 4pt;
    font-weight: 700; font-size: 9pt;
  }
  .grade-A { background: #D1FAE5; color: #065F46; }
  .grade-B { background: #FEF3C7; color: #78350F; }
  .grade-D, .grade-F { background: #FEE2E2; color: #991B1B; }

  /* Nav & Journey */
  .nav-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6mm; }
  .nav-block { }
  .nav-block-title {
    font-size: 11pt; font-weight: 700; color: #0F172A;
    margin-bottom: 3mm; padding-bottom: 2mm;
    border-bottom: 2px solid #E2E8F0;
  }
  .nav-list { list-style: none; padding: 0; margin: 0; }
  .nav-list li {
    padding: 2mm 0; font-size: 10pt; color: #1E293B;
    display: flex; align-items: center; gap: 3mm;
  }
  .nav-list li .nav-text { flex: 1; }
  .nav-list li .nav-href { font-size: 8.5pt; color: #94A3B8; font-family: 'JetBrains Mono', monospace; }
  .checklist-item {
    display: flex; align-items: flex-start; gap: 3mm;
    padding: 2.5mm 0; border-bottom: 1px solid #F1F5F9;
    font-size: 10pt;
  }
  .checklist-item:last-child { border-bottom: 0; }
  .checklist-icon { width: 5mm; flex-shrink: 0; font-size: 11pt; }
  .checklist-label { flex: 1; color: #334155; }

  /* Screenshot */
  .screenshot-wrap {
    margin: 4mm 0; border: 1px solid #E2E8F0; border-radius: 8pt;
    overflow: hidden; max-height: 90mm;
    page-break-inside: avoid;
  }
  .screenshot-wrap img { width: 100%; display: block; }

  /* Note callouts */
  .callout {
    background: #EFF6FF; border-left: 4pt solid #3B82F6;
    padding: 4mm 5mm; border-radius: 0 6pt 6pt 0;
    font-size: 10pt; color: #1E40AF; margin: 4mm 0;
  }
</style>`;

// ─── Section renderers ────────────────────────────────────────────────

function renderCover(client, scoring, audit) {
  const date = new Date(audit.runAt).toISOString().slice(0, 10);
  const gradeColor = scoring.score >= 80 ? '#D1FAE5;color:#065F46'
    : scoring.score >= 65 ? '#FEF3C7;color:#92400E'
    : '#FEE2E2;color:#991B1B';
  return `
  <div class="cover">
    <div>
      <div class="cover-brand">Allied Health Media · Website QA</div>
      <div class="cover-title">${esc(client.name)}</div>
      <div class="cover-subtitle">Comprehensive performance, SEO, CRO and compliance audit — actionable findings ranked by business impact, with root cause and exact fix for every issue.</div>
    </div>
    <div class="cover-score">
      <div class="cover-score-label">Overall Health</div>
      <div class="cover-score-num">${scoring.score}</div>
      <div class="cover-score-status">${esc(scoring.status)}</div>
      <span class="cover-score-grade" style="background:${gradeColor}">Grade ${esc(scoring.grade)}</span>
    </div>
    <div class="cover-meta">
      <div class="cover-meta-block">
        <div class="cover-meta-label">Site</div>
        <div class="cover-meta-value">${esc(client.url)}</div>
      </div>
      <div class="cover-meta-block">
        <div class="cover-meta-label">Audited</div>
        <div class="cover-meta-value">${esc(date)}</div>
      </div>
      <div class="cover-meta-block">
        <div class="cover-meta-label">Pages</div>
        <div class="cover-meta-value">${audit.pages?.length || 0}</div>
      </div>
    </div>
  </div>`;
}

function renderExecSummary(client, audit, scoring, issues, topFixes) {
  const lh = audit.lighthouse || {};
  const m = lh.mobile?.scores || {};
  const d = lh.desktop?.scores || {};
  const grouped = groupIssues(issues);
  const high = grouped.filter((g) => g.severity === 'high').length;
  const medium = grouped.filter((g) => g.severity === 'medium').length;
  const low = grouped.filter((g) => g.severity === 'low').length;

  const lhCard = (label, mv, dv) => `
    <div class="lh-card">
      <div class="lh-card-label">${label}</div>
      <div class="lh-card-row"><span class="lh-card-strategy">Mobile</span>${miniBar(mv)}</div>
      <div class="lh-card-row"><span class="lh-card-strategy">Desktop</span>${miniBar(dv)}</div>
    </div>`;

  return `
  <div class="page">
    <div class="brand-strip"></div>
    <div class="section-eyebrow">Executive Summary</div>
    <h2>Overall Health</h2>
    <hr class="divider"/>

    <div style="display:flex; gap:10mm; align-items:center; margin-bottom:8mm;">
      ${scoreGauge(scoring.score, scoring.grade, scoring.status)}
      <div style="flex:1;">
        <div style="font-size:11pt; color:#64748B; font-weight:600; text-transform:uppercase; letter-spacing:1px;">Status</div>
        <div style="font-size:20pt; font-weight:700; color:#0F172A; margin:2mm 0 4mm;">${esc(scoring.status)}</div>
        <div style="display:flex; gap:6mm; margin-top:4mm;">
          <div><span class="pill pill-sev-high">${high} high impact</span></div>
          <div><span class="pill pill-sev-medium">${medium} medium impact</span></div>
          <div><span class="pill pill-sev-low">${low} observations</span></div>
        </div>
        <div style="font-size:10pt; color:#64748B; margin-top:4mm;">Across <strong>${audit.pages?.length || 0}</strong> audited pages.</div>
      </div>
    </div>

    <h3>Lighthouse Scoreboard</h3>
    <div class="lh-grid">
      ${lhCard('Performance', m.performance, d.performance)}
      ${lhCard('Accessibility', m.accessibility, d.accessibility)}
      ${lhCard('Best Practices', m.bestPractices, d.bestPractices)}
      ${lhCard('SEO (technical)', m.seo, d.seo)}
    </div>
    ${lh.mobile?.metrics ? `
      <div class="callout">
        <strong>Mobile Core Web Vitals:</strong>
        LCP ${esc(lh.mobile.metrics.lcp || '—')} ·
        CLS ${esc(lh.mobile.metrics.cls || '—')} ·
        TBT ${esc(lh.mobile.metrics.tbt || '—')} ·
        FCP ${esc(lh.mobile.metrics.fcp || '—')} ·
        Speed Index ${esc(lh.mobile.metrics.speedIndex || '—')}
      </div>` : ''}

    ${topFixes.length ? `
    <div class="top-fixes">
      <div class="top-fixes-title">🎯 Top 3 Fixes — Pareto: highest leverage, fix first</div>
      ${topFixes.map((f, i) => {
        const flag = (f.examples && f.examples[0]) || f.flag;
        const where = f.occurrences > 1 ? `${f.occurrences} pages affected` : f.wheres ? f.wheres[0] : f.where;
        return `
        <div class="top-fix">
          <div class="top-fix-num">${i + 1}</div>
          <div class="top-fix-body">
            <div class="top-fix-title">${esc(flag)}</div>
            <div class="top-fix-where">${esc(where)}</div>
            ${f.howToFix ? `<div class="top-fix-fix">→ ${esc(f.howToFix)}</div>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>` : ''}

    <div class="footer">
      <span>${esc(client.name)} · ${esc(client.url)}</span>
      <span>1 · Executive Summary</span>
    </div>
  </div>`;
}

function renderStrengths(strengths, client) {
  if (!strengths.length) return '';
  return `
  <div class="page">
    <div class="brand-strip"></div>
    <div class="section-eyebrow">What's working</div>
    <h2>Strengths</h2>
    <hr class="divider"/>
    <p style="color:#64748B; margin-bottom:6mm;">Before getting into fixes — here's what this site already does well.</p>
    <div class="strengths-grid">
      ${strengths.map((s) => `<div class="strength">✓ ${esc(s)}</div>`).join('')}
    </div>
    <div class="footer">
      <span>${esc(client.name)} · ${esc(client.url)}</span>
      <span>2 · Strengths</span>
    </div>
  </div>`;
}

function renderIssueCard(group) {
  const flag = (group.examples && group.examples[0]) || group.flag;
  const wheresHtml = group.occurrences === 1
    ? `<span class="pill pill-where">📍 ${esc(group.wheres[0])}</span>`
    : `<span class="pill pill-where">📍 ${group.occurrences} pages</span>`;
  return `
    <div class="issue-card ${group.severity}">
      <div class="issue-flag">${esc(flag)}</div>
      <div class="issue-meta">
        <span class="pill pill-sev-${group.severity}">${sevLabel(group.severity)}</span>
        ${trackPill(group.track)}
        ${wheresHtml}
      </div>
      ${group.rootCause ? `<div class="issue-row"><div class="issue-row-label">Root cause</div><div class="issue-row-text">${esc(group.rootCause)}</div></div>` : ''}
      ${group.howToFix ? `<div class="issue-row"><div class="issue-row-label">How to fix</div><div class="issue-row-text">${esc(group.howToFix)}</div></div>` : ''}
      ${group.businessImpact ? `<div class="issue-row"><div class="issue-row-label">Business impact</div><div class="issue-row-text">${esc(group.businessImpact)}</div></div>` : ''}
      ${group.occurrences > 1 ? `
        <div class="issue-pages-list">
          <strong>Affected pages (${group.occurrences}):</strong>
          <ul>${group.wheres.slice(0, 12).map((w) => `<li>${esc(w)}</li>`).join('')}${group.wheres.length > 12 ? `<li><em>+ ${group.wheres.length - 12} more</em></li>` : ''}</ul>
        </div>` : ''}
    </div>`;
}

function renderIssuesPage(issues, client, pageNum) {
  const grouped = groupIssues(issues);
  const tracks = {
    marketing: grouped.filter((g) => g.track === 'marketing'),
    dev: grouped.filter((g) => g.track === 'dev'),
  };
  const sortFn = (a, b) => {
    const r = { high: 0, medium: 1, low: 2 };
    if (r[a.severity] !== r[b.severity]) return r[a.severity] - r[b.severity];
    return b.occurrences - a.occurrences;
  };
  tracks.marketing.sort(sortFn);
  tracks.dev.sort(sortFn);

  const renderTrack = (issues, title, icon, sub) => {
    if (!issues.length) return `
      <div class="track-section">
        <div class="track-header">
          <span class="track-header-icon">${icon}</span>
          <div><div class="track-header-text">${title}</div><div class="track-header-sub">${sub}</div></div>
        </div>
        <p style="color:#94A3B8; font-style:italic;">No ${title.toLowerCase()} issues found.</p>
      </div>`;
    const bySev = { high: issues.filter((i) => i.severity === 'high'), medium: issues.filter((i) => i.severity === 'medium'), low: issues.filter((i) => i.severity === 'low') };
    const sevBlock = (sev, label) => bySev[sev].length === 0 ? '' : `
      <div class="severity-group-title"><span class="severity-dot" style="background:${sevColor(sev)}"></span>${label}</div>
      ${bySev[sev].map(renderIssueCard).join('')}`;
    return `
      <div class="track-section">
        <div class="track-header">
          <span class="track-header-icon">${icon}</span>
          <div><div class="track-header-text">${title}</div><div class="track-header-sub">${sub}</div></div>
        </div>
        ${sevBlock('high', 'High Impact')}
        ${sevBlock('medium', 'Medium Impact')}
        ${sevBlock('low', 'Observations')}
      </div>`;
  };

  return `
  <div class="page">
    <div class="brand-strip"></div>
    <div class="section-eyebrow">Action plan</div>
    <h2>Issues &amp; Fixes</h2>
    <hr class="divider"/>
    <p style="color:#64748B; margin-bottom:6mm;">Each issue includes severity, where it occurs, root cause, the exact fix, and the expected business impact. Issues are split by who can fix them.</p>
    ${renderTrack(tracks.marketing, 'Marketing / CSM Track', '✍️', 'Fixes the consultant or CSM can action through WordPress admin or content updates.')}
    ${renderTrack(tracks.dev, 'Development Team Track', '🛠️', 'Fixes that need a developer / agency — code, hosting, plugins, schema.')}
    <div class="footer">
      <span>${esc(client.name)} · ${esc(client.url)}</span>
      <span>${pageNum} · Issues &amp; Fixes</span>
    </div>
  </div>`;
}

function renderPerPage(client, audit, scoring, pageNum) {
  const cards = audit.pages.map((page, i) => {
    const ps = scoring.pageScores[i] || {};
    const label = pageLabel(client, page);
    const seo = page.seo || {};
    const cro = seo.cro || {};
    const compliance = seo.compliance || {};
    const scoreClass = ps.score >= 80 ? 'high' : ps.score >= 65 ? 'med' : 'low';
    const yn = (b) => b ? '<span class="check-pill yes">✓</span>' : '<span class="check-pill no">✗</span>';

    const subscores = ps.breakdown && !ps.breakdown.broken ? `
      <div class="page-subscores">
        <div class="page-subscore"><div class="page-subscore-label">SEO</div><div class="page-subscore-value">${ps.breakdown.seo}</div></div>
        <div class="page-subscore"><div class="page-subscore-label">Compliance</div><div class="page-subscore-value">${ps.breakdown.compliance}</div></div>
        <div class="page-subscore"><div class="page-subscore-label">CRO</div><div class="page-subscore-value">${ps.breakdown.cro}</div></div>
      </div>` : '';

    return `
      <div class="page-card">
        <div class="page-card-head">
          <div>
            <div class="page-card-name">${esc(label)}</div>
            <div class="page-card-url">${esc(page.url)}</div>
          </div>
          <div class="page-score-chip ${scoreClass}">${ps.score ?? '—'}</div>
        </div>
        ${subscores}
        <div class="page-meta-grid">
          <div class="page-meta-label">Title</div>
          <div class="page-meta-value">${esc(seo.title || '—')}${seo.title ? ` <span style="color:#94A3B8">(${seo.title.length} chars)</span>` : ''}</div>
          <div class="page-meta-label">Meta Description</div>
          <div class="page-meta-value">${esc(seo.metaDescription || '—')}${seo.metaDescription ? ` <span style="color:#94A3B8">(${seo.metaDescription.length} chars)</span>` : ''}</div>
          <div class="page-meta-label">H1</div>
          <div class="page-meta-value">${esc(seo.firstH1 || '—')} <span style="color:#94A3B8">(${seo.h1Count ?? 0} on page)</span></div>
          <div class="page-meta-label">Focus Keyword</div>
          <div class="page-meta-value">${seo.focusKeyword?.keyword ? `<code>${esc(seo.focusKeyword.keyword)}</code>` : '<span style="color:#94A3B8">not detected</span>'}</div>
        </div>
        <div style="margin-top:4mm;">
          <div class="page-meta-label" style="margin-bottom:2mm;">Compliance</div>
          <div class="check-row">
            ${yn(compliance.footerAhm)} AHM footer
            ${yn(compliance.privacy)} Privacy
            ${yn(compliance.terms)} Terms
            ${yn(compliance.cookie)} Cookie
            ${yn(compliance.form)} Form
            ${yn(compliance.gtm || compliance.ga)} GTM/GA
          </div>
        </div>
        <div style="margin-top:3mm;">
          <div class="page-meta-label" style="margin-bottom:2mm;">CRO Signals</div>
          <div class="check-row">
            ${yn(cro.phoneClickable)} Tel
            ${yn(cro.bookingLink)} Booking
            ${yn(cro.testimonials || cro.starRating || cro.googleReviews)} Social proof
            ${yn(cro.medicalSchema || cro.localBusinessSchema)} Schema
            ${yn(cro.gmcNumber)} GMC
            <span class="check-pill" style="background:#F1F5F9;color:#475569">CTAs: ${cro.ctaButtonCount ?? 0}</span>
          </div>
        </div>
        ${page.images ? `
          <div style="margin-top:3mm;">
            <div class="page-meta-label" style="margin-bottom:2mm;">Images</div>
            <div style="font-size:10pt; color:#475569;">${page.images.total} total · ${page.images.externalCount} off-domain · <strong style="color:${page.images.flagged.length > 0 ? '#B91C1C' : '#059669'}">${page.images.flagged.length} flagged</strong></div>
          </div>` : ''}
        ${page.vision?.summary ? `<div class="callout" style="margin-top:3mm;"><strong>Layout review:</strong> ${esc(page.vision.summary)}</div>` : ''}
      </div>`;
  }).join('');

  return `
  <div class="page">
    <div class="brand-strip"></div>
    <div class="section-eyebrow">Page-level breakdown</div>
    <h2>Per-Page Analysis</h2>
    <hr class="divider"/>
    <p style="color:#64748B; margin-bottom:6mm;">Individual scores and on-page check for every audited page.</p>
    ${cards}
    <div class="footer">
      <span>${esc(client.name)} · ${esc(client.url)}</span>
      <span>${pageNum} · Per-Page Analysis</span>
    </div>
  </div>`;
}

function renderUrlStructure(client, audit, pageNum) {
  const rows = (audit.pages || []).map((page) => {
    const seo = page.seo || {};
    const slug = seo.slug || {};
    const yn = (b) => b ? '<span class="yes">✓</span>' : '<span class="no">✗</span>';
    const titleOk = !!seo.title && seo.title.length >= 25 && seo.title.length <= 70;
    const metaOk = !!seo.metaDescription && seo.metaDescription.length >= 70 && seo.metaDescription.length <= 175;
    const h1Ok = seo.h1Count === 1;
    const status = seo.status ?? (seo.error ? 'ERR' : '?');
    const grade = slug.grade || 'A';
    return `<tr>
      <td style="max-width:80mm;word-break:break-all;">${esc(pageLabel(client, page))}</td>
      <td>${slug.depth ?? '—'}</td>
      <td>${status}</td>
      <td>${yn(titleOk)}</td>
      <td>${yn(metaOk)}</td>
      <td>${yn(h1Ok)}</td>
      <td><span class="grade-pill grade-${grade.replace('+','')}">${grade}</span>${slug.reasons?.length ? `<div style="font-size:8pt;color:#94A3B8;">${esc(slug.reasons.join(', '))}</div>` : ''}</td>
    </tr>`;
  }).join('');

  // Duplicate titles
  const dupMap = new Map();
  for (const page of audit.pages || []) {
    const t = (page.seo?.title || '').trim();
    if (!t) continue;
    if (!dupMap.has(t)) dupMap.set(t, []);
    dupMap.get(t).push(page.url);
  }
  const dups = [...dupMap.entries()].filter(([, urls]) => urls.length > 1);

  return `
  <div class="page">
    <div class="brand-strip"></div>
    <div class="section-eyebrow">Indexability</div>
    <h2>URL Structure</h2>
    <hr class="divider"/>
    <table class="url-table">
      <thead><tr><th>Page</th><th>Depth</th><th>Status</th><th>Title</th><th>Meta</th><th>H1</th><th>Slug Grade</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${dups.length ? `
      <h3 style="margin-top:8mm;">Duplicate &lt;title&gt; tags detected</h3>
      ${dups.map(([t, urls]) => `
        <div class="callout"><strong>"${esc(t)}"</strong> appears on:<br/>${urls.map(esc).join('<br/>')}</div>
      `).join('')}` : ''}
    <div class="footer">
      <span>${esc(client.name)} · ${esc(client.url)}</span>
      <span>${pageNum} · URL Structure</span>
    </div>
  </div>`;
}

function renderJourney(client, audit, pageNum) {
  const home = (audit.pages || []).find((p) => p.url === client.url) || (audit.pages || [])[0];
  if (!home || !home.seo) return '';
  const seo = home.seo;
  const cro = seo.cro || {};
  const compliance = seo.compliance || {};
  const nav = seo.nav || [];
  const forms = seo.forms || { primaryFields: 0, formCount: 0 };

  const checkRow = (cond, label) => `
    <div class="checklist-item">
      <div class="checklist-icon">${cond ? '✅' : '❌'}</div>
      <div class="checklist-label">${esc(label)}</div>
    </div>`;

  return `
  <div class="page">
    <div class="brand-strip"></div>
    <div class="section-eyebrow">User experience</div>
    <h2>Navigation &amp; Patient Journey</h2>
    <hr class="divider"/>
    <div class="nav-grid">
      <div class="nav-block">
        <div class="nav-block-title">Top-Level Navigation</div>
        ${nav.length === 0 ? '<p style="color:#94A3B8; font-style:italic;">Could not detect a primary navigation menu.</p>' : `
          <ul class="nav-list">${nav.map((n) => `<li><span class="nav-text">${esc(n.text)}</span><span class="nav-href">${esc(n.href)}</span></li>`).join('')}</ul>`}
      </div>
      <div class="nav-block">
        <div class="nav-block-title">Conversion Path</div>
        ${checkRow(cro.phoneClickable, 'Phone (tap-to-call)')}
        ${checkRow(cro.emailClickable, 'Email link')}
        ${checkRow(cro.bookingLink, 'Booking CTA')}
        ${checkRow(forms.formCount > 0, `Contact form ${forms.formCount > 0 ? `(${forms.primaryFields} fields)${forms.primaryFields >= 8 ? ' ⚠️ long' : ''}` : ''}`)}
        <div class="checklist-item"><div class="checklist-icon">📊</div><div class="checklist-label">${cro.ctaButtonCount} CTA buttons on page</div></div>
      </div>
      <div class="nav-block">
        <div class="nav-block-title">Trust Signals</div>
        ${checkRow(cro.testimonials, 'Testimonials')}
        ${checkRow(cro.starRating, 'Star rating widgets')}
        ${checkRow(cro.googleReviews, 'Google Reviews / Trustpilot / Doctify')}
        ${checkRow(cro.gmcNumber, 'GMC number visible')}
        ${checkRow(cro.medicalSchema, 'Medical Schema.org')}
        ${checkRow(cro.localBusinessSchema, 'Local-Business Schema.org')}
      </div>
      <div class="nav-block">
        <div class="nav-block-title">Footer Compliance</div>
        ${checkRow(compliance.footerAhm, 'AHM credit')}
        ${checkRow(compliance.privacy, 'Privacy Policy')}
        ${checkRow(compliance.terms, 'Terms')}
        ${checkRow(compliance.cookie, 'Cookie Policy')}
        ${checkRow(compliance.gtm || compliance.ga, `Analytics ${compliance.gtm ? '(GTM)' : compliance.ga ? '(GA)' : ''}`)}
      </div>
    </div>
    <div class="footer">
      <span>${esc(client.name)} · ${esc(client.url)}</span>
      <span>${pageNum} · Navigation &amp; Journey</span>
    </div>
  </div>`;
}

// ─── Main ─────────────────────────────────────────────────────────────

function buildHtml(client, audit) {
  const scoring = siteScore(audit);
  const issues = gatherIssues(client, audit);
  const topFixes = pickTopFixes(issues, 3);
  const strengths = checkSiteStrengths(audit);

  const sections = [];
  sections.push(renderCover(client, scoring, audit));
  sections.push(renderExecSummary(client, audit, scoring, issues, topFixes));
  let pageNum = 1;
  if (strengths.length) sections.push(renderStrengths(strengths, client));
  pageNum = strengths.length ? 3 : 2;
  sections.push(renderIssuesPage(issues, client, ++pageNum));
  sections.push(renderPerPage(client, audit, scoring, ++pageNum));
  sections.push(renderUrlStructure(client, audit, ++pageNum));
  sections.push(renderJourney(client, audit, ++pageNum));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${esc(client.name)} — Website QA</title>${STYLES}</head>
<body>
${sections.join('\n')}
</body></html>`;
}

module.exports = { buildHtml };
