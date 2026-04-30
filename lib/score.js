// Computes overall + per-page health scores (0-100) and a letter grade.
//
// Weighted blend:
//   30% CRO + Compliance signals
//   25% SEO basics (title, meta, H1, schema, canonical)
//   25% Lighthouse Performance (mobile-weighted)
//   20% Accessibility + Best Practices
//
// For each page we also compute a per-page score (no Lighthouse mix-in,
// since LH only ran on the homepage).

function clamp(n) { return Math.max(0, Math.min(100, Math.round(n))); }

function letterGrade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B+';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C+';
  if (score >= 50) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function statusLabel(score) {
  if (score >= 85) return 'Healthy';
  if (score >= 70) return 'Needs Polish';
  if (score >= 55) return 'Action Required';
  if (score >= 40) return 'At Risk';
  return 'Critical';
}

// ─── Per-page scoring (uses only what we measure per page) ─────────────
function pageScore(page) {
  if (!page || !page.seo || page.seo.error) return { score: 0, breakdown: { broken: true } };
  const seo = page.seo;
  const compliance = seo.compliance || {};
  const cro = seo.cro || {};

  // SEO sub-score (0-100)
  let seoPoints = 0; let seoMax = 0;
  const seoCheck = (cond, pts) => { seoMax += pts; if (cond) seoPoints += pts; };
  seoCheck(!!seo.title && seo.title.length >= 25 && seo.title.length <= 70, 20);
  seoCheck(!!seo.metaDescription && seo.metaDescription.length >= 70 && seo.metaDescription.length <= 175, 20);
  seoCheck(seo.h1Count === 1, 15);
  seoCheck(!!seo.viewport, 10);
  seoCheck(!!seo.canonical, 10);
  seoCheck(!!seo.schemaJsonLd, 10);
  seoCheck(!!seo.lang, 5);
  seoCheck(!!seo.focusKeyword?.keyword, 10);
  const seoScore = seoMax ? (seoPoints / seoMax) * 100 : 0;

  // Compliance sub-score
  let compPoints = 0; let compMax = 0;
  const compCheck = (cond, pts) => { compMax += pts; if (cond) compPoints += pts; };
  compCheck(!!compliance.footerAhm, 15);
  compCheck(!!compliance.privacy, 20);
  compCheck(!!compliance.terms, 15);
  compCheck(!!compliance.cookie, 15);
  compCheck(!!compliance.form, 15);
  compCheck(!!(compliance.gtm || compliance.ga), 20);
  const compScore = compMax ? (compPoints / compMax) * 100 : 0;

  // CRO sub-score
  let croPoints = 0; let croMax = 0;
  const croCheck = (cond, pts) => { croMax += pts; if (cond) croPoints += pts; };
  croCheck(!!cro.phoneClickable, 20);
  croCheck(!!cro.bookingLink, 20);
  croCheck(!!(cro.testimonials || cro.starRating || cro.googleReviews), 15);
  croCheck(!!(cro.medicalSchema || cro.localBusinessSchema), 15);
  croCheck(!!cro.gmcNumber, 10);
  croCheck(cro.ctaButtonCount > 0 && cro.ctaButtonCount <= 8, 20);
  const croScore = croMax ? (croPoints / croMax) * 100 : 0;

  // Vision penalty — high-severity layout issues knock points
  let visionPenalty = 0;
  for (const issue of (page.vision?.issues || [])) {
    const sev = (issue.severity || '').toLowerCase();
    if (sev === 'high' || sev === 'critical') visionPenalty += 5;
    else if (sev === 'medium') visionPenalty += 2;
  }
  visionPenalty = Math.min(visionPenalty, 25);

  const blend = (seoScore * 0.4) + (compScore * 0.25) + (croScore * 0.35) - visionPenalty;
  return {
    score: clamp(blend),
    breakdown: {
      seo: clamp(seoScore),
      compliance: clamp(compScore),
      cro: clamp(croScore),
      visionPenalty,
    },
  };
}

// ─── Overall site score (homepage Lighthouse + all pages averaged) ─────
function siteScore(audit) {
  const pages = audit.pages || [];
  const pageScores = pages.map(pageScore);
  const validPageScores = pageScores.filter((p) => !p.breakdown.broken);
  const avgPage = validPageScores.length
    ? validPageScores.reduce((a, p) => a + p.score, 0) / validPageScores.length
    : 0;

  const lh = audit.lighthouse || {};
  const m = lh.mobile?.scores || {};
  const d = lh.desktop?.scores || {};

  // Lighthouse blend: mobile weighted 2:1 vs desktop (mobile dominates UK healthcare traffic)
  const lhBlend = (key) => {
    const mv = m[key]; const dv = d[key];
    if (mv == null && dv == null) return null;
    if (mv == null) return dv;
    if (dv == null) return mv;
    return (mv * 2 + dv) / 3;
  };

  const perf = lhBlend('performance');
  const a11y = lhBlend('accessibility');
  const bp = lhBlend('bestPractices');
  const lhSeo = lhBlend('seo');

  // Final weighted blend
  const components = [
    { val: avgPage, weight: 35 },
    { val: perf, weight: 25 },
    { val: a11y, weight: 15 },
    { val: lhSeo, weight: 15 },
    { val: bp, weight: 10 },
  ].filter((c) => c.val != null);

  const totalWeight = components.reduce((a, c) => a + c.weight, 0) || 1;
  const final = components.reduce((a, c) => a + c.val * c.weight, 0) / totalWeight;

  return {
    score: clamp(final),
    grade: letterGrade(clamp(final)),
    status: statusLabel(clamp(final)),
    components: {
      pageAvg: clamp(avgPage),
      performance: perf != null ? clamp(perf) : null,
      accessibility: a11y != null ? clamp(a11y) : null,
      seo: lhSeo != null ? clamp(lhSeo) : null,
      bestPractices: bp != null ? clamp(bp) : null,
    },
    pageScores: pageScores.map((p, i) => ({ url: pages[i]?.url, ...p })),
  };
}

module.exports = { siteScore, pageScore, letterGrade, statusLabel };
