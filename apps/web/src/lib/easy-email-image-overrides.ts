/**
 * Override Easy Email's default placeholder asset URLs.
 *
 * Easy Email v4 OSS hardcodes its default block assets (Hero background,
 * Social icons, Carousel slides, Accordion arrows, etc.) to the author's
 * personal Vercel demo deployment at `easy-email-m-ryan.vercel.app`. As of
 * 2026-05 that deployment returns 404, so every block that ships a default
 * image renders broken in the editor and any sent mail.
 *
 * Easy Email exposes `ImageManager.add()` precisely for this — it overlays
 * a custom map onto the built-in registry, and the block factories pick up
 * the new URLs the next time they're invoked.
 *
 * For Image / Carousel placeholders we use inline SVG data URLs so they
 * match Easy Email's own drop-zone aesthetic (light gray bg + monochrome
 * icon + label) and require zero network round-trips. For the few small
 * social / accordion icons we keep placehold.co since data URLs of tiny
 * coloured PNGs aren't worth inlining and rendering matches what the
 * shipped templates expect.
 *
 * Side-effect module: import it from any editor page that uses Easy Email.
 * IMPORTANT: import order matters — easy-email-core itself runs
 * `ImageManager.add(defaultImagesMap)` at module top level, so this file
 * MUST be imported AFTER `easy-email-core` / `easy-email-editor` /
 * `easy-email-extensions`. Otherwise the lazy-loaded editor module init
 * will overwrite our overrides with the broken vercel-demo URLs.
 */
import { ImageManager } from 'easy-email-core';

/**
 * Build a gray placeholder SVG matching Easy Email's drop-zone style:
 * light gray background, dark gray photo-frame glyph centred above a
 * caption. Returned as a data URL so the canvas can render it inline.
 */
function makePlaceholderSvgUrl(label: string, width: number, height: number): string {
  const cx = width / 2;
  const cy = height / 2;
  // Photo-frame icon centred ~30px above the caption. 80x60 frame matches
  // the visual weight of the reference column drop-zone glyph.
  const iconX = cx - 40;
  const iconY = cy - 50;
  const textY = cy + 36;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#eaeaea"/>
  <g transform="translate(${iconX} ${iconY})" stroke="#6b7280" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <rect x="0" y="0" width="80" height="60" rx="6"/>
    <circle cx="22" cy="22" r="6" fill="#6b7280" stroke="none"/>
    <path d="M6 52 L28 32 L44 46 L58 36 L80 52"/>
  </g>
  <text x="${cx}" y="${textY}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="20" fill="#374151">${label}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

ImageManager.add({
  // Social block — the default Facebook / Google / Twitter icons.
  IMAGE_02: 'https://placehold.co/50x50/1877F2/FFFFFF/png?text=f',
  IMAGE_03: 'https://placehold.co/50x50/EA4335/FFFFFF/png?text=G',
  IMAGE_04: 'https://placehold.co/50x50/1DA1F2/FFFFFF/png?text=t',
  // Accordion block — collapsed/expanded chevron icons.
  IMAGE_09: 'https://placehold.co/32x32/E5E7EB/374151/png?text=%2B',
  IMAGE_10: 'https://placehold.co/32x32/E5E7EB/374151/png?text=-',
  // Carousel block — three default slides.
  IMAGE_15: makePlaceholderSvgUrl('幻灯片 1', 600, 400),
  IMAGE_16: makePlaceholderSvgUrl('幻灯片 2', 600, 400),
  IMAGE_17: makePlaceholderSvgUrl('幻灯片 3', 600, 400),
  // Image block — editor renders this when the user has not yet picked a
  // src (BasicBlock fallback at `getImg("IMAGE_59")` for empty / merge-tag
  // src values). Production output keeps the user's real src untouched.
  IMAGE_59: makePlaceholderSvgUrl('图片', 600, 400),
});
