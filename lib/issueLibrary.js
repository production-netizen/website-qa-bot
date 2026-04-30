// Maps every flag the bot can emit to a structured "issue card":
//   { match, severity, track, rootCause, howToFix, businessImpact }
//
// `track` is "marketing" (CSM/SEO/CRO can fix in WordPress admin or content)
// or "dev" (needs a developer/agency — code, hosting, plugins).
//
// First match wins. Patterns are ordered specific-first.
//
// Each entry's strings are templates: `${value}` placeholders are substituted
// from the flag text capture groups (see `enrichFlag`).

const ENTRIES = [
  // ─── HTTP / availability ─────────────────────────────────────────────
  {
    match: /HTTP (\d{3})/i,
    severity: 'high',
    track: 'dev',
    rootCause: 'Server returned an HTTP error response — page is broken or unreachable for visitors and search engines.',
    howToFix: 'Open the URL in a private window. If 4xx, check the WordPress permalink, slug, or restore deleted page. If 5xx, check hosting (PHP errors, plugin conflict). Roll back the last plugin/theme update if recent.',
    businessImpact: 'Page is invisible to Google → zero organic traffic for this URL. Any backlinks pointing here lose value. Estimated loss: 100% of this page\'s traffic.',
  },

  // ─── SEO basics ──────────────────────────────────────────────────────
  {
    match: /Missing <title>/i,
    severity: 'high',
    track: 'marketing',
    rootCause: 'Page has no <title> tag — most critical SEO element is absent.',
    howToFix: 'WordPress: install/configure RankMath or Yoast → edit the page → fill the SEO Title (50-60 chars, primary keyword first). Example: "Knee Surgery London | Mr Smith FRCS".',
    businessImpact: 'Google shows the URL or random body text in search results → ~70% drop in click-through rate. Estimated loss: 5-10 patient enquiries/month per affected page.',
  },
  {
    match: /Title too short.*\((\d+) chars/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'SEO title is shorter than 25 characters — wastes valuable search-result real estate and competitors fill it instead.',
    howToFix: 'Expand the SEO title to 50-60 chars. Format: [Primary Keyword] | [Specialism / Location] | [Brand]. Example: "Sinusitis Treatment London | Dr Vikas Acharya ENT".',
    businessImpact: 'Lower CTR in search results — competitors with full titles (~55 chars) outclick by 15-25%. Estimated: 1-3 lost enquiries/month per page.',
  },
  {
    match: /Title too long.*\((\d+) chars/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'Google truncates titles over 60 characters — patients see "..." instead of your full message.',
    howToFix: 'Shorten to ~55 chars. Drop filler words ("Welcome to", "We Provide"). Lead with the keyword. Example: "Robotic Hernia Surgery | Mr Phadnis FRCS" (40 chars).',
    businessImpact: 'Truncated CTAs reduce clicks by 5-10%. Subtle but compounds across all pages.',
  },
  {
    match: /Missing meta description/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'No meta description — Google auto-generates a snippet from random page text, often pulling cookie banners or boilerplate.',
    howToFix: 'WordPress: edit page → SEO plugin (RankMath/Yoast) → Meta Description field. 140-160 chars, include primary keyword + a benefit + CTA. Example: "Expert sinusitis treatment by London ENT specialist Dr Acharya. Same-week appointments. Book your consultation today."',
    businessImpact: 'Auto-snippets reduce CTR by 5-15% vs. crafted descriptions. Estimated: 2-4 lost enquiries/month per page.',
  },
  {
    match: /Meta description too short.*\((\d+) chars/i,
    severity: 'low',
    track: 'marketing',
    rootCause: 'Description shorter than 70 chars wastes the snippet space competitors will fill.',
    howToFix: 'Expand to 140-160 chars. Add a benefit, a trust signal, or a CTA. Example: append "Same-week consultations available. GMC-registered consultant."',
    businessImpact: 'Marginal CTR loss; competitors with fuller snippets win the click ~10% more often.',
  },
  {
    match: /Meta description too long.*\((\d+) chars/i,
    severity: 'low',
    track: 'marketing',
    rootCause: 'Google truncates descriptions over ~155 chars — your CTA may be cut off.',
    howToFix: 'Trim to 140-155 chars. Make sure the call-to-action ("Book today", "Call now") fits inside the limit.',
    businessImpact: 'Lost CTA visibility = ~5% lower click-through.',
  },
  {
    match: /No <h1> heading/i,
    severity: 'high',
    track: 'marketing',
    rootCause: 'Page has no <h1> — search engines and screen readers can\'t identify the main topic.',
    howToFix: 'Add a single <h1> at the top of the page using the page\'s primary keyword. WordPress: most page builders set the title block as <h1> automatically — check that "Heading 1" is selected on the top heading.',
    businessImpact: 'SEO ranking penalty + accessibility fail (WCAG 2.1). Pages without H1 rank ~20% lower for their target keyword on average.',
  },
  {
    match: /Multiple <h1> tags found \((\d+)/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'Multiple H1 tags confuse search engines about the main topic of the page.',
    howToFix: 'Identify the H1s (Inspect Element → Ctrl+F → "h1"). Demote all but one to H2. WordPress: change "Heading 1" to "Heading 2" in the block editor for non-primary headings.',
    businessImpact: 'Diluted topical signal. Mild SEO ranking impact — typically 1-2 position drops.',
  },

  // ─── Mobile / canonical / lang / schema ──────────────────────────────
  {
    match: /Missing <meta name="viewport"/i,
    severity: 'high',
    track: 'dev',
    rootCause: 'No mobile viewport meta tag — page renders at desktop width on phones, requiring pinch-to-zoom.',
    howToFix: 'Add to the <head>: <meta name="viewport" content="width=device-width, initial-scale=1">. Most WordPress themes include this — if missing, the theme is broken or a plugin removed it.',
    businessImpact: 'Mobile users (~70% of traffic) see a desktop-sized page on a phone screen — bounce rate jumps 40%+. Google demotes non-mobile-friendly pages.',
  },
  {
    match: /Missing <link rel="canonical"/i,
    severity: 'medium',
    track: 'dev',
    rootCause: 'No canonical URL — risk of duplicate-content penalties when same page is accessed via /, ?utm_source=, or trailing-slash variants.',
    howToFix: 'WordPress: RankMath/Yoast adds canonicals automatically; verify the SEO plugin is active. Otherwise add <link rel="canonical" href="[full-url]"> to the <head>.',
    businessImpact: 'Search authority gets diluted across URL variants instead of consolidating onto one canonical version.',
  },
  {
    match: /No JSON-LD structured data/i,
    severity: 'medium',
    track: 'dev',
    rootCause: 'No Schema.org markup — Google can\'t generate rich snippets (star ratings, FAQs, doctor info) in search results.',
    howToFix: 'Add Schema.org JSON-LD for @type "Physician" or "MedicalClinic" with name, address, telephone, GMC registration, areaServed. RankMath PRO or Schema Pro plugin can do this through the admin UI.',
    businessImpact: 'Loses rich-snippet real estate in search results. Sites with rich snippets get 25-35% higher CTR for the same ranking position.',
  },
  {
    match: /Missing <html lang/i,
    severity: 'low',
    track: 'dev',
    rootCause: '<html> tag missing the lang attribute.',
    howToFix: 'WordPress: should be set automatically via language_attributes(). If missing, theme\'s header.php is broken — check <html <?php language_attributes(); ?>>.',
    businessImpact: 'Minor accessibility (screen readers can\'t pick voice) and SEO (geo-targeting unclear) impact.',
  },

  // ─── AHM compliance ──────────────────────────────────────────────────
  {
    match: /Footer does NOT contain "Allied Health Media"/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'AHM footer credit is missing — required compliance for all AHM-built sites.',
    howToFix: 'WordPress: Appearance → Customize → Footer (or theme footer settings) → add "Powered by Allied Health Media" with a link to https://alliedhealthmedia.co.uk.',
    businessImpact: 'Compliance issue — not a patient-facing problem but breaks AHM brand standards across the portfolio.',
  },
  {
    match: /No "Privacy Policy" link/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'No Privacy Policy link found — UK GDPR compliance failure.',
    howToFix: 'WordPress: Settings → Privacy → ensure a Privacy Policy page is set, then add a footer link to it. AHM template policy at /privacy-policy/.',
    businessImpact: 'Legal exposure under UK GDPR. ICO enforcement is rare for small clinics but the absence undermines trust signals.',
  },
  {
    match: /No "Terms" link/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'No Terms & Conditions link found.',
    howToFix: 'Add a Terms page (use AHM template) and link from the footer.',
    businessImpact: 'Legal/trust gap. Patients comparing clinics may notice the absence.',
  },
  {
    match: /No "Cookie Policy" link/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'No Cookie Policy link — required under UK GDPR / PECR if any analytics/tracking is used.',
    howToFix: 'Install a cookie consent banner (e.g. CookieYes, Complianz) and link to a Cookie Policy page from the footer.',
    businessImpact: 'PECR compliance gap. Most patients won\'t care, but ICO has fined for missing consent banners.',
  },
  {
    match: /No <form> on page/i,
    severity: 'high',
    track: 'marketing',
    rootCause: 'Page has no contact form — visitors have no inline conversion path on this page.',
    howToFix: 'Add a contact / enquiry form (Gravity Forms, WPForms, or Fluent Forms). Keep it short: Name, Email, Phone, Message. Place it above the fold or in a sticky sidebar on long pages.',
    businessImpact: 'Visitors who don\'t want to call have no way to convert here. ~40% of visitors prefer form-fill over phone — that traffic bounces.',
  },
  {
    match: /No GTM container or GA tag detected/i,
    severity: 'high',
    track: 'dev',
    rootCause: 'No analytics installed — page traffic is invisible. Cannot measure conversions, campaigns, or SEO progress.',
    howToFix: 'Install GTM (Google Tag Manager) via the "GTM4WP" or "Site Kit by Google" plugin. Inside GTM, fire GA4 + Meta Pixel + LinkedIn Insight as needed.',
    businessImpact: 'Flying blind — can\'t prove ROI of marketing spend, can\'t identify drop-offs, can\'t optimise. Operating without analytics is the #1 reason marketing budgets get cut.',
  },

  // ─── CRO / trust ─────────────────────────────────────────────────────
  {
    match: /No conversion path on page/i,
    severity: 'high',
    track: 'marketing',
    rootCause: 'No phone link, no email link, and no form — visitors literally cannot convert here.',
    howToFix: 'Add at minimum: a clickable phone number (<a href="tel:+44...">) in the header, an enquiry form, and a "Book a Consultation" button linking to your booking system.',
    businessImpact: 'Direct conversion loss. Estimated: every 100 visitors here = ~3-5 lost enquiries/month vs. a page with proper CTAs.',
  },
  {
    match: /No clickable phone number/i,
    severity: 'high',
    track: 'marketing',
    rootCause: 'Phone number is shown as plain text — mobile users can\'t tap to call.',
    howToFix: 'Wrap the number in an anchor: <a href="tel:+442012345678">020 1234 5678</a>. WordPress: edit the header template or use a "Click-to-Call" plugin.',
    businessImpact: '~70% of patient-search traffic is mobile. Mobile users abandon when they can\'t tap-to-call. Estimated: 3-6 lost calls/month.',
  },
  {
    match: /No booking\/appointment CTA/i,
    severity: 'high',
    track: 'marketing',
    rootCause: 'No "Book a Consultation" button or booking-system link found.',
    howToFix: 'Add a prominent "Book a Consultation" button in the header AND mid-page. Link to your booking flow (Calendly, GHL, or contact form). Use action language: "Book Consultation" not "Contact Us".',
    businessImpact: 'Industry data: pages with prominent booking CTAs convert 2-3x better. Estimated: 4-8 lost bookings/month.',
  },
  {
    match: /No social proof on page/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'No testimonials, reviews, ratings, or trust badges visible — patients have no third-party validation.',
    howToFix: 'Add: 3-5 patient testimonials with names + initials, a Google Reviews widget (RankMath has one, or use "Widgets for Google Reviews"), and any professional accreditations (BAAPS, ENT-UK, BMA).',
    businessImpact: 'Conversion uplift from testimonials is well-documented at 15-30%. Without them, patients comparing clinics often choose the competitor with visible social proof.',
  },
  {
    match: /No medical or local-business Schema/i,
    severity: 'medium',
    track: 'dev',
    rootCause: 'No Schema.org @type Physician/MedicalClinic/LocalBusiness — Google doesn\'t see this as a medical entity.',
    howToFix: 'Add JSON-LD to the <head> for @type "Physician" with name, image, address, telephone, sameAs (LinkedIn, Doctify), medicalSpecialty. RankMath PRO does this through admin.',
    businessImpact: 'Loses rich-result eligibility (knowledge panel, local pack, doctor card). Estimated: 10-20% lower CTR for branded searches.',
  },
  {
    match: /No styled CTA buttons detected/i,
    severity: 'high',
    track: 'marketing',
    rootCause: 'Zero buttons found on page — visitors have no clear next action.',
    howToFix: 'Add a primary CTA button (use a vivid color that contrasts with your brand). Action language: "Book Consultation", "Get a Free Assessment". Place above the fold AND at the end of every section.',
    businessImpact: 'Pages without clear CTAs convert at <0.5%. Pages with prominent CTAs convert at 2-5%. Direct multiplier on enquiry volume.',
  },
  {
    match: /Many competing CTAs detected \((\d+) buttons/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'Too many buttons of equal visual weight — Aagaard LPO principle violated. Visitors paralysed by choice.',
    howToFix: 'Pick ONE primary CTA per page (the most valuable action — usually "Book a Consultation"). Style it boldly. Demote other buttons to text links or secondary outline-style buttons.',
    businessImpact: 'Choice overload reduces conversion 15-30%. Single-CTA pages consistently outperform multi-CTA pages in A/B tests.',
  },
  {
    match: /No GMC number visible/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'No GMC number shown — patients can\'t verify the consultant is registered.',
    howToFix: 'Add the GMC number to the footer and About page. Format: "GMC: 1234567". Link to https://www.gmc-uk.org/registration-and-licensing for verification.',
    businessImpact: 'Trust signal patients actively look for in the UK. Absence raises concern, especially for cosmetic/elective procedures.',
  },

  // ─── Lighthouse score-based ─────────────────────────────────────────
  {
    match: /(Mobile|Desktop) Performance critically low: (\d+)/i,
    severity: 'high',
    track: 'dev',
    rootCause: 'Lighthouse Performance score below 50 — page is severely slow.',
    howToFix: 'Run PageSpeed Insights for specifics. Common fixes: optimise images (WebP + responsive sizes), enable WP Rocket / LiteSpeed Cache, defer non-critical JS, drop unused plugins. If score stays low, hosting is undersized — upgrade.',
    businessImpact: 'Google ranks slow sites lower. Every 1s delay → ~7% drop in conversions. Mobile users abandon at 3s+ load. Estimated: 30-50% of traffic lost to slow loads.',
  },
  {
    match: /(Mobile|Desktop) Performance low: (\d+)/i,
    severity: 'medium',
    track: 'dev',
    rootCause: 'Performance below 70 — page loads slowly.',
    howToFix: 'PageSpeed Insights → fix top 3 opportunities. Usually image compression, render-blocking JS, and caching.',
    businessImpact: 'Conversion drop ~10-15% vs. fast competitors. Search rankings affected on mobile.',
  },
  {
    match: /(Mobile|Desktop) Accessibility low: (\d+)/i,
    severity: 'high',
    track: 'dev',
    rootCause: 'Accessibility below 70 — site fails WCAG 2.1 in multiple ways.',
    howToFix: 'PageSpeed Insights → Accessibility tab. Common fixes: add alt text to images, fix colour contrast (use a contrast checker), label form inputs, add ARIA roles where needed.',
    businessImpact: 'Legal exposure under Equality Act 2010. Excludes ~15% of UK adults with disabilities from converting.',
  },
  {
    match: /(Mobile|Desktop) Accessibility below target: (\d+)/i,
    severity: 'medium',
    track: 'dev',
    rootCause: 'Accessibility below 90 — minor WCAG issues present.',
    howToFix: 'PageSpeed Insights → Accessibility → fix the listed audits. Usually colour contrast or missing alt text.',
    businessImpact: 'Minor exclusion of users with disabilities. Easy wins available.',
  },
  {
    match: /(Mobile|Desktop) SEO low: (\d+)/i,
    severity: 'high',
    track: 'dev',
    rootCause: 'Lighthouse SEO score below 70 — basic technical SEO failing.',
    howToFix: 'PageSpeed Insights → SEO tab → fix listed audits. Usually missing meta description, viewport, or robots.txt blocking.',
    businessImpact: 'Page may be effectively invisible to Google. Direct ranking suppression.',
  },
  {
    match: /(Mobile|Desktop) SEO below target: (\d+)/i,
    severity: 'medium',
    track: 'dev',
    rootCause: 'SEO score below 90 — minor technical SEO gaps.',
    howToFix: 'Audit listed items in PageSpeed Insights → SEO. Quick wins typically.',
    businessImpact: 'Mild ranking suppression. Easy to fix.',
  },
  {
    match: /(Mobile|Desktop) Best Practices low: (\d+)/i,
    severity: 'medium',
    track: 'dev',
    rootCause: 'Best Practices score below 80 — security/quality issues (mixed HTTP, deprecated APIs, console errors).',
    howToFix: 'PageSpeed Insights → Best Practices tab. Usually: switch http:// images to https://, fix console errors, update jQuery.',
    businessImpact: 'Quality / trust signal. Mixed-content warnings can show as "Not Secure" to users.',
  },

  // ─── Vision (layout / UX) ───────────────────────────────────────────
  {
    match: /\] (.+) _Fix:/i,
    severity: null, // inherit from flag's own severity (vision issues already classified)
    track: 'marketing',
    rootCause: 'Visual / layout issue detected by AI vision review.',
    howToFix: null, // already in the flag text after "_Fix:"
    businessImpact: 'Layout problems erode trust and increase bounce. Mobile-break issues especially: ~70% of traffic is mobile.',
  },

  // ─── Image audit ────────────────────────────────────────────────────
  {
    match: /Stock host: ([\w\.]+)/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'Image is hot-linked from a stock photo CDN — likely unlicensed and impersonal.',
    howToFix: 'Replace with original photography (the consultant in clinic) or properly-licensed stock from your subscription. Save the file to your site (don\'t hot-link).',
    businessImpact: 'Patients recognise stock photos = lower trust. AHM brand standard requires real consultant photos.',
  },
  {
    match: /Stock filename: (.+)/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'Image filename suggests it\'s an unmodified stock photo (e.g. shutterstock_12345.jpg).',
    howToFix: 'Replace with original photography. If using stock, rename the file descriptively before upload (e.g. "knee-surgery-consultation.jpg").',
    businessImpact: 'Trust hit. Generic-feeling site loses against competitors with real photography.',
  },
  {
    match: /Missing alt: (.+)/i,
    severity: 'low',
    track: 'marketing',
    rootCause: 'Image has no alt text — accessibility and SEO miss.',
    howToFix: 'WordPress: Media Library → click image → fill the "Alternative Text" field. Describe what\'s in the image, including the keyword if natural.',
    businessImpact: 'Mild SEO loss (image search) + accessibility gap for screen-reader users.',
  },

  // ─── URL / slug quality ─────────────────────────────────────────────
  {
    match: /Poor URL slug/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'URL contains numeric IDs, query strings, uppercase characters, or underscores — search engines and patients both prefer descriptive hyphenated slugs.',
    howToFix: 'WordPress: edit the post → Permalink → change to a descriptive slug (e.g. "/sinusitis-treatment-london" instead of "/4094/" or "?p=512"). After changing, set up a 301 redirect from the old URL using "Redirection" plugin to preserve any inbound links.',
    businessImpact: 'Numeric/query-string URLs rank lower for the target keyword and are harder to share. Estimated: 5-15% lower CTR on these pages in search results.',
  },

  // ─── Form friction ──────────────────────────────────────────────────
  {
    match: /Long contact form \((\d+) visible fields\)/i,
    severity: 'medium',
    track: 'marketing',
    rootCause: 'Contact form has too many fields — Aagaard LPO research: every additional field drops conversion ~7%.',
    howToFix: 'Trim form to: Name, Phone, Email, Message (4 fields). Move secondary fields (DOB, address, insurance) to a follow-up step after the lead is captured. WordPress: edit the form in Gravity Forms / WPForms → mark non-essential fields as conditional or move them to a confirmation page.',
    businessImpact: 'Forms with 8+ fields convert ~50% lower than 3-4 field forms. Estimated: 2-4 lost enquiries/month on the contact page alone.',
  },
];

// ─── Generic fallback when nothing matches ─────────────────────────────
const FALLBACK = {
  severity: 'low',
  track: 'marketing',
  rootCause: 'Issue detected — see the flag text for specifics.',
  howToFix: 'Investigate the specific element flagged and apply standard SEO/CRO best practices.',
  businessImpact: 'Minor — not a primary conversion or ranking blocker.',
};

function enrichFlag(flag, fallbackSeverity = null) {
  const text = String(flag);
  for (const e of ENTRIES) {
    if (e.match.test(text)) {
      return {
        severity: e.severity || fallbackSeverity || 'medium',
        track: e.track,
        rootCause: e.rootCause,
        howToFix: e.howToFix,
        businessImpact: e.businessImpact,
        flag: text,
      };
    }
  }
  return { ...FALLBACK, severity: fallbackSeverity || FALLBACK.severity, flag: text };
}

module.exports = { enrichFlag };
