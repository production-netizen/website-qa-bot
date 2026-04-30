// Gathers what the site does well — the "What This Site Does Right" section.
// Manus calls it "Strengths". We surface positive observations so the report
// is balanced + the consultant feels recognised, not just attacked.

function checkSiteStrengths(audit) {
  const strengths = [];
  const pages = audit.pages || [];
  if (pages.length === 0) return strengths;

  const home = pages[0];
  const lh = audit.lighthouse || {};
  const m = lh.mobile?.scores || {};
  const d = lh.desktop?.scores || {};

  // ─── Performance wins ────────────────────────────────────────────────
  if (m.performance != null && m.performance >= 80) {
    strengths.push(`Strong mobile performance (${m.performance}/100) — page loads quickly on phones.`);
  }
  if (d.performance != null && d.performance >= 90) {
    strengths.push(`Excellent desktop performance (${d.performance}/100).`);
  }
  if (m.accessibility != null && m.accessibility >= 90) {
    strengths.push(`High accessibility score (${m.accessibility}/100) — site works well for users with disabilities.`);
  }
  if (m.seo != null && m.seo >= 95) {
    strengths.push(`Lighthouse SEO score is excellent (${m.seo}/100) — technical SEO basics all in place.`);
  }

  // ─── Aggregate signals across pages ─────────────────────────────────
  const totalPages = pages.filter((p) => p.seo && !p.seo.error).length || 1;
  const withTitle = pages.filter((p) => p.seo?.title && p.seo.title.length >= 25 && p.seo.title.length <= 70).length;
  const withMeta = pages.filter((p) => p.seo?.metaDescription && p.seo.metaDescription.length >= 70 && p.seo.metaDescription.length <= 175).length;
  const withH1 = pages.filter((p) => p.seo?.h1Count === 1).length;
  const withSchema = pages.filter((p) => p.seo?.schemaJsonLd).length;
  const withCanonical = pages.filter((p) => p.seo?.canonical).length;

  if (withTitle === totalPages) strengths.push(`SEO titles are well-formed on all ${totalPages} audited pages (correct length, present on every page).`);
  if (withMeta === totalPages) strengths.push(`Every audited page has a properly-sized meta description.`);
  if (withH1 === totalPages) strengths.push(`H1 structure is clean — exactly one <h1> per page across all audited pages.`);
  if (withSchema >= Math.ceil(totalPages * 0.7)) strengths.push(`Schema.org structured data is present on most pages — Google can generate rich snippets.`);
  if (withCanonical === totalPages) strengths.push(`Canonical URLs are set everywhere — no duplicate-content risk.`);

  // ─── Home-page CRO wins ─────────────────────────────────────────────
  const cro = home?.seo?.cro || {};
  const compliance = home?.seo?.compliance || {};

  if (cro.phoneClickable) strengths.push('Phone number is clickable (tap-to-call) on the homepage — mobile-friendly conversion path.');
  if (cro.bookingLink) strengths.push('A booking / appointment CTA is present on the homepage.');
  if (cro.testimonials || cro.starRating || cro.googleReviews) strengths.push('Social proof is visible (testimonials, reviews, or rating widgets).');
  if (cro.medicalSchema) strengths.push('Medical Schema.org markup detected — qualifies for Google\'s doctor/clinic rich results.');
  if (cro.gmcNumber) strengths.push('GMC number is visible — patients can verify credentials.');
  if (cro.ctaButtonCount >= 1 && cro.ctaButtonCount <= 4) strengths.push(`Clear CTA hierarchy on the homepage (${cro.ctaButtonCount} call-to-action buttons — focused, not overwhelming).`);

  if (compliance.gtm) strengths.push('Google Tag Manager is installed — analytics + retargeting infrastructure ready.');
  else if (compliance.ga) strengths.push('Google Analytics is installed.');
  if (compliance.privacy && compliance.terms && compliance.cookie) strengths.push('All three legal pages linked from footer (Privacy, Terms, Cookies) — UK GDPR-ready.');
  if (compliance.footerAhm) strengths.push('AHM footer credit present — brand-compliant.');

  // ─── Image / vision wins ─────────────────────────────────────────────
  const totalFlagged = pages.reduce((a, p) => a + (p.images?.flagged?.length || 0), 0);
  const totalImages = pages.reduce((a, p) => a + (p.images?.total || 0), 0);
  if (totalImages > 5 && totalFlagged === 0) {
    strengths.push(`Image hygiene is clean — ${totalImages} images audited, none flagged as stock or missing alt text.`);
  }

  const cleanVisionPages = pages.filter((p) => p.vision?.summary && /clean/i.test(p.vision.summary)).length;
  if (cleanVisionPages > 0) {
    strengths.push(`Layout review found ${cleanVisionPages === pages.length ? 'all pages' : `${cleanVisionPages} of ${pages.length} pages`} visually clean — no broken sections or spacing issues.`);
  }

  return strengths;
}

module.exports = { checkSiteStrengths };
