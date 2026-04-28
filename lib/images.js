const { URL } = require('url');

const STOCK_HOST_PATTERNS = [
  /shutterstock\.com/i,
  /istockphoto\.com/i,
  /gettyimages\.com/i,
  /alamy\.com/i,
  /depositphotos\.com/i,
  /dreamstime\.com/i,
  /123rf\.com/i,
  /adobestock\.com/i,
  /unsplash\.com/i,
  /pexels\.com/i,
  /pixabay\.com/i,
  /freepik\.com/i,
  /googleusercontent\.com/i,
  /bing\.com\/th/i,
];

const STOCK_FILENAME_PATTERNS = [
  /shutterstock[_\-]?\d+/i,
  /istock[_\-]?\d+/i,
  /getty[_\-]?\d+/i,
  /depositphotos[_\-]?\d+/i,
  /stock[_\-]?(photo|image)/i,
  /^\d{6,}\.(jpg|jpeg|png|webp)$/i,
  /^images?[_\-]?\d+\.(jpg|jpeg|png|webp)$/i,
  /unsplash/i,
  /pexels/i,
];

function flagImage(srcAbs, alt) {
  const flags = [];
  let host = '';
  let pathname = '';
  try { const u = new URL(srcAbs); host = u.hostname; pathname = u.pathname; } catch { return flags; }

  for (const re of STOCK_HOST_PATTERNS) if (re.test(host)) flags.push(`Stock host: ${host}`);
  const filename = pathname.split('/').pop() || '';
  for (const re of STOCK_FILENAME_PATTERNS) if (re.test(filename)) { flags.push(`Stock filename: ${filename}`); break; }

  if (!alt || alt.trim().length === 0) flags.push(`Missing alt: ${filename || host}`);
  return flags;
}

function extractImages(html, baseUrl) {
  const out = [];
  const re = /<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const srcMatch = tag.match(/\bsrc=["']([^"']+)["']/i)
      || tag.match(/\bdata-src=["']([^"']+)["']/i)
      || tag.match(/\bdata-lazy-src=["']([^"']+)["']/i);
    if (!srcMatch) continue;
    const altMatch = tag.match(/\balt=["']([^"']*)["']/i);
    let abs = srcMatch[1];
    if (abs.startsWith('//')) abs = 'https:' + abs;
    try { abs = new URL(abs, baseUrl).toString(); } catch { continue; }
    if (/^data:/i.test(abs)) continue;
    if (/\.svg(\?|$)/i.test(abs)) continue;
    out.push({ src: abs, alt: altMatch ? altMatch[1] : '' });
  }
  return out;
}

function auditPageImages(html, baseUrl) {
  const imgs = extractImages(html, baseUrl);
  const baseHost = (() => { try { return new URL(baseUrl).hostname; } catch { return ''; } })();
  const flagged = [];
  let externalCount = 0;
  for (const img of imgs) {
    let host = '';
    try { host = new URL(img.src).hostname; } catch {}
    const isExternal = host && baseHost && host !== baseHost && !host.endsWith(baseHost);
    if (isExternal) externalCount++;
    const flags = flagImage(img.src, img.alt);
    if (flags.length || isExternal) flagged.push({ src: img.src, alt: img.alt, external: isExternal, flags });
  }
  return { total: imgs.length, externalCount, flagged };
}

module.exports = { auditPageImages, extractImages };
