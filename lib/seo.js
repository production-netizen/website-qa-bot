const fetch = require('node-fetch');

const UA = 'Mozilla/5.0 (compatible; AHM-WebsiteQA/1.0; +https://alliedhealthmedia.co.uk)';

function decodeEntities(s) {
  if (!s) return s;
  return s
    // Numeric decimal: &#38; → &, &#8217; → ’
    .replace(/&#(\d+);/g, (_, n) => {
      const code = parseInt(n, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : _;
    })
    // Numeric hex: &#x27; → '
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : _;
    })
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
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

function extractNavigation(html) {
  // Look for the first <nav> element (or header > nav). Pull anchor text.
  const navMatch = html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)
    || html.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i);
  if (!navMatch) return [];
  const inner = navMatch[1];
  const items = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(inner))) {
    const href = m[1];
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, '').trim());
    if (!text || text.length > 60) continue;
    if (/^#$|^javascript:|^mailto:|^tel:/i.test(href)) continue;
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    items.push({ text, href });
    if (items.length >= 12) break;
  }
  return items;
}

function countFormFields(html) {
  // Find every <form> on page, count visible <input>/<textarea>/<select> inside it.
  const formMatches = html.match(/<form\b[\s\S]*?<\/form>/gi) || [];
  if (formMatches.length === 0) return { formCount: 0, primaryFields: 0 };
  let max = 0;
  for (const f of formMatches) {
    const inputs = (f.match(/<input\b[^>]*>/gi) || []).filter((i) => !/type=["'](?:hidden|submit|button|image|reset)["']/i.test(i));
    const textareas = (f.match(/<textarea\b/gi) || []).length;
    const selects = (f.match(/<select\b/gi) || []).length;
    const total = inputs.length + textareas + selects;
    if (total > max) max = total;
  }
  return { formCount: formMatches.length, primaryFields: max };
}

function slugQuality(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '') || '/';
    if (path === '/') return { grade: 'A', reasons: [] };
    const segments = path.split('/').filter(Boolean);
    const reasons = [];
    let grade = 'A';
    const last = segments[segments.length - 1];
    if (/page_id=|p=\d+|\?[a-z]+=/i.test(u.search) || /^\d+$/.test(last)) { grade = 'D'; reasons.push('numeric/query-string slug'); }
    if (last && last.length > 60) { reasons.push('overly long slug'); if (grade === 'A') grade = 'B'; }
    if (last && /[A-Z]/.test(last)) { reasons.push('uppercase characters in slug'); if (grade === 'A') grade = 'B'; }
    if (last && /_/.test(last)) { reasons.push('underscores instead of hyphens'); if (grade === 'A') grade = 'B'; }
    if (segments.length > 4) { reasons.push(`deep URL (${segments.length} segments)`); if (grade === 'A') grade = 'B'; }
    return { grade, reasons, depth: segments.length };
  } catch {
    return { grade: 'F', reasons: ['unparseable URL'], depth: 0 };
  }
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
  const nav = extractNavigation(html);
  const forms = countFormFields(html);
  const slug = slugQuality(finalUrl || url);

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
  // Suppress homepage-only CRO flags on blog posts / individual articles —
  // it's normal not to have a booking form / GMC number / styled CTA on a
  // long-form article. Detect "blog-ish" URLs by path heuristics.
  const isBlogish = (() => {
    try {
      const u = new URL(url);
      const p = u.pathname;
      if (/\/(blog|news|article|insight|insights|press|story|stories)\//.test(p)) return true;
      // WP-style /post-slug/numeric-id/ or /post-slug-with-many-words/
      if (/\/[a-z0-9-]{20,}\/(?:\d+\/)?$/.test(p)) return true;
      return false;
    } catch { return false; }
  })();
  if (isBlogish) {
    // Blog posts get a slimmer CRO check — only the most critical signals.
    // Drop form-missing, booking-CTA, GMC, and competing-CTA flags here.
    const blogIgnore = /(No <form>|No booking\/appointment CTA|No GMC number|Many competing CTAs|No styled CTA buttons)/i;
    for (let i = flags.length - 1; i >= 0; i--) {
      if (blogIgnore.test(flags[i])) flags.splice(i, 1);
    }
  }

  // Form-friction flag — long forms hurt conversion
  if (forms.primaryFields >= 8) {
    flags.push(`Long contact form (${forms.primaryFields} visible fields) — Aagaard LPO: shorter forms convert better, target 3-5 fields`);
  }

  // Slug quality flag — only emit for clearly bad slugs
  if (slug.grade === 'D' || slug.grade === 'F') {
    flags.push(`Poor URL slug — ${slug.reasons.join(', ')} — patients and Google prefer descriptive slugs like "/sinusitis-treatment"`);
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
    nav,
    forms,
    slug,
    flags,
  };
}

module.exports = { analyseUrl, fetchHtml };
