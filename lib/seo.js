const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (compatible; AHM-WebsiteQA/1.0; +https://alliedhealthmedia.co.uk)';

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    timeout: 30 * 1000,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
  });
  const html = await res.text();
  return { status: res.status, finalUrl: res.url, html, contentType: res.headers.get('content-type') || '' };
}

function extractTag(html, regex) {
  const m = html.match(regex);
  return m ? decodeEntities(m[1].trim()) : null;
}

function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  if (m) return decodeEntities(m[1].trim());
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1].trim()) : null;
}

function countMatches(html, re) {
  return (html.match(re) || []).length;
}

function detectFocusKeyword(html, title) {
  const m = html.match(/rank-?math|rankmath|yoast/i);
  const focus = extractMeta(html, 'rankmath:focus_keyword') || extractMeta(html, 'yoast:focuskw');
  if (focus) return { keyword: focus, source: 'meta' };
  if (title) {
    const tokens = title.split(/[|—–\-:]/)[0].trim();
    return { keyword: tokens || null, source: 'title-fallback', plugin: m ? m[0].toLowerCase() : null };
  }
  return { keyword: null, source: null, plugin: m ? m[0].toLowerCase() : null };
}

function trunc(s, n = 80) {
  if (!s) return s;
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function flagsFor({ title, h1Count, firstH1, metaDescription, viewport, schemaJsonLd, canonical, hasFooterAhm, hasPrivacyLink, hasTermsLink, hasCookieLink, hasFormPost, hasGtm, hasGa, lang }) {
  const flags = [];
  if (!title) flags.push('Missing <title> tag — page has no SEO title at all');
  else if (title.length < 25) flags.push(`Title too short: "${trunc(title)}" (${title.length} chars, target 25-70)`);
  else if (title.length > 70) flags.push(`Title too long: "${trunc(title)}" (${title.length} chars, target 25-70 — Google truncates >60)`);

  if (!metaDescription) flags.push('Missing meta description — Google will auto-generate (poor CTR)');
  else if (metaDescription.length < 70) flags.push(`Meta description too short: "${trunc(metaDescription)}" (${metaDescription.length} chars, target 70-175)`);
  else if (metaDescription.length > 175) flags.push(`Meta description too long: "${trunc(metaDescription)}" (${metaDescription.length} chars, Google truncates >155)`);

  if (h1Count === 0) flags.push('No <h1> heading on page — search engines and screen readers can\'t identify the main topic');
  else if (h1Count > 1) flags.push(`Multiple <h1> tags found (${h1Count} on page) — should be exactly 1; first one: "${trunc(firstH1 || '')}"`);

  if (!viewport) flags.push('Missing <meta name="viewport"> — page won\'t scale on mobile (will look broken on phones)');
  if (!canonical) flags.push('Missing <link rel="canonical"> — risks duplicate-content penalties');
  if (!schemaJsonLd) flags.push('No JSON-LD structured data — missing Schema.org markup (no rich snippets in Google)');
  if (!lang) flags.push('Missing <html lang="..."> attribute — accessibility + SEO hit');

  if (!hasFooterAhm) flags.push('Footer does NOT contain "Allied Health Media" — required AHM compliance check');
  if (!hasPrivacyLink) flags.push('No "Privacy Policy" link found anywhere on page (legal compliance)');
  if (!hasTermsLink) flags.push('No "Terms" link found (legal compliance)');
  if (!hasCookieLink) flags.push('No "Cookie Policy" link found (UK GDPR compliance)');
  if (!hasFormPost) flags.push('No <form> on page — visitors have no inline conversion path');
  if (!hasGtm && !hasGa) flags.push('No GTM container or GA tag detected — page traffic is invisible to analytics');

  return flags;
}

async function analyseUrl(url) {
  const { status, finalUrl, html, contentType } = await fetchHtml(url);
  if (status >= 400) {
    return { url, finalUrl, status, error: `HTTP ${status}`, flags: [`HTTP ${status}`] };
  }
  if (!/text\/html|application\/xhtml/i.test(contentType)) {
    return { url, finalUrl, status, error: `Non-HTML response (${contentType})`, flags: [`Not HTML: ${contentType}`] };
  }

  const title = extractTag(html, /<title[^>]*>([^<]*)<\/title>/i);
  const metaDescription = extractMeta(html, 'description');
  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi) || [];
  const h1Count = h1Match.length;
  const firstH1 = h1Match[0] ? decodeEntities(h1Match[0].replace(/<[^>]*>/g, '').trim()) : null;
  const viewport = extractMeta(html, 'viewport');
  const canonical = extractTag(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || extractTag(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const schemaJsonLd = countMatches(html, /<script[^>]+type=["']application\/ld\+json["']/gi) > 0;
  const lang = extractTag(html, /<html[^>]+lang=["']([^"']+)["']/i);

  const lowerHtml = html.toLowerCase();
  const hasFooterAhm = /allied\s*health\s*media/i.test(html);
  const hasPrivacyLink = /privacy[\s-]?policy/i.test(html);
  const hasTermsLink = /terms[\s-]?(of[\s-]?service|and[\s-]?conditions|&[\s-]?conditions)/i.test(html);
  const hasCookieLink = /cookie[\s-]?policy/i.test(html);
  const hasFormPost = /<form\b/i.test(html);
  const hasGtm = /googletagmanager\.com\/gtm\.js|gtm-[a-z0-9]+/i.test(html);
  const hasGa = /google-analytics\.com|gtag\(\s*['"]config['"]|ga\(\s*['"]create['"]/i.test(html);

  // CRO heuristics — trust signals, CTAs, contact, social proof
  const hasPhoneClickable = /<a[^>]+href=["']tel:/i.test(html);
  const hasEmailClickable = /<a[^>]+href=["']mailto:/i.test(html);
  const hasBookingLink = /book\s*(now|consultation|appointment|online)|schedule\s*(a|an)?\s*(consultation|appointment|call)|calendly|cal\.com\/|gohighlevel|leadconnectorhq/i.test(html);
  const hasTestimonials = /testimonials?|reviews?|patient[\s-]stor(y|ies)|what (our|my|patients) say|hear from (our|my) patients/i.test(html);
  const hasStarRating = /★|⭐|class=["'][^"']*(star|rating)[^"']*["']/i.test(html);
  const hasGoogleReviews = /google[\s-]?reviews?|trustpilot|doctify|iwgc/i.test(html);
  const hasGmcNumber = /gmc[\s:]*\d{6,7}|general medical council/i.test(html);
  const hasNhsMention = /\bnhs\b/i.test(html);
  const hasMedicalSchema = /"@type"\s*:\s*"(Physician|MedicalOrganization|MedicalBusiness|Hospital|HealthAndBeautyBusiness|MedicalClinic)"/i.test(html);
  const hasLocalBusinessSchema = /"@type"\s*:\s*"LocalBusiness"/i.test(html);
  const hasFaqSchema = /"@type"\s*:\s*"FAQPage"/i.test(html);
  const ctaButtonCount = (html.match(/<(button|a)[^>]*class=["'][^"']*(cta|button|btn)[^"']*["']/gi) || []).length;

  const focus = detectFocusKeyword(html, title);

  const flags = flagsFor({
    title, h1Count, firstH1, metaDescription, viewport, schemaJsonLd, canonical,
    hasFooterAhm, hasPrivacyLink, hasTermsLink, hasCookieLink, hasFormPost, hasGtm, hasGa, lang,
  });

  // CRO flags — verbose so Usama can see exactly what was checked
  if (!hasPhoneClickable && !hasEmailClickable && !hasFormPost) {
    flags.push('No conversion path on page — searched for: <a href="tel:...">, <a href="mailto:...">, and <form> — none of the three found');
  } else if (!hasPhoneClickable) {
    flags.push('No clickable phone number — searched for <a href="tel:..."> — not found (mobile users can\'t tap-to-call)');
  }
  if (!hasBookingLink && hasFormPost === false) {
    flags.push('No booking/appointment CTA — searched for: "book now", "book consultation", "schedule appointment", calendly.com, cal.com, leadconnectorhq, gohighlevel — none found');
  }
  if (!hasTestimonials && !hasStarRating && !hasGoogleReviews) {
    flags.push('No social proof on page — searched for: testimonials, reviews, patient stories, ★/⭐ rating widgets, Google Reviews, Trustpilot, Doctify, IWGC — none found');
  }
  if (!hasMedicalSchema && !hasLocalBusinessSchema) {
    flags.push('No medical or local-business Schema.org markup — searched JSON-LD for @type Physician/MedicalOrganization/MedicalClinic/LocalBusiness — none found (no rich snippets in Google search)');
  }
  if (ctaButtonCount === 0) {
    flags.push('No styled CTA buttons detected — searched for <button> or <a class="cta|button|btn"> — zero found (no clear next action for visitors)');
  } else if (ctaButtonCount > 8) {
    flags.push(`Many competing CTAs detected (${ctaButtonCount} buttons on page) — Aagaard LPO principle: every page needs ONE primary action; too many splits attention`);
  }
  if (!hasGmcNumber) {
    flags.push('No GMC number visible — searched for "GMC: 1234567" or "General Medical Council" — patients can\'t verify credentials');
  }

  return {
    url,
    finalUrl,
    status,
    title,
    metaDescription,
    h1Count,
    firstH1,
    viewport,
    canonical,
    lang,
    schemaJsonLd,
    focusKeyword: focus,
    compliance: {
      footerAhm: hasFooterAhm,
      privacy: hasPrivacyLink,
      terms: hasTermsLink,
      cookie: hasCookieLink,
      form: hasFormPost,
      gtm: hasGtm,
      ga: hasGa,
    },
    cro: {
      phoneClickable: hasPhoneClickable,
      emailClickable: hasEmailClickable,
      bookingLink: hasBookingLink,
      testimonials: hasTestimonials,
      starRating: hasStarRating,
      googleReviews: hasGoogleReviews,
      gmcNumber: hasGmcNumber,
      nhsMention: hasNhsMention,
      medicalSchema: hasMedicalSchema,
      localBusinessSchema: hasLocalBusinessSchema,
      faqSchema: hasFaqSchema,
      ctaButtonCount,
    },
    flags,
  };
}

module.exports = { analyseUrl, fetchHtml };
