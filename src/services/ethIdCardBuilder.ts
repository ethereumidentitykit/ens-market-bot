import { emojiMappingService } from './emojiMappingService';

/**
 * Turns an EthID NFT card SVG into inline markup whose emoji use the bot's
 * bundled Apple emoji instead of whatever font the rendering machine has.
 *
 * EthID's SVG (see metadata.ethid.org) is: background (gradient rect or avatar
 * <image>), an embedded Satoshi @font-face, a drop-shadow filter, the ENS logo
 * as four <path>s, and ONE single-line <text> holding the name. Long names get
 * a smaller font-size rather than wrapping. (Unknown names are detected by
 * EthIdImageService before the SVG reaches this builder.)
 *
 * Emoji inside <text> are plain Unicode, so they render with the local emoji
 * font (Google's on EthID's own PNG endpoint, nothing at all on Vercel's
 * Chromium). We drop the <text>, and overlay a <foreignObject> with the same
 * position, size and font whose emoji are replaced by inline Apple emoji SVGs.
 *
 * All ids (EthID's `dropShadow`/`paint0_linear` and the ids inside each emoji
 * SVG) are suffixed per instance so several cards can share one HTML page.
 */

const CARD_SIZE = 270;
const TEXT_ELEMENT = /<text\b([^>]*)>([\s\S]*?)<\/text>/;

/**
 * Sizing for the inline emoji SVGs so they sit on the text baseline like glyphs.
 * Replaces the generic style emojiMappingService attaches (1.2em, middle-aligned).
 * The emoji also get their own class: the tweet-image templates style
 * `.emoji-inline` globally with !important (1.2em boxes plus side margins for
 * names in the HTML overlay), which would push a long emoji name off the card.
 */
const EMOJI_STYLE = 'display:inline-block;width:1em;height:1em;vertical-align:-0.12em;margin:0 0.02em';
const EMOJI_CLASS = 'nft-card-emoji';

/**
 * Vertical offset from the SVG text baseline to the top of an HTML line box with
 * line-height 1 in Satoshi Bold. Chosen by overlaying renders against EthID's
 * own <text> output; tweak here if the label ever drifts vertically.
 */
const BASELINE_TO_TOP_RATIO = 0.87;

/**
 * Build the inline card markup. Returns null when the SVG carries no <text>
 * to rebuild.
 */
export async function buildEthIdSvgCard(svg: string, instanceId: string): Promise<string | null> {
  const textMatch = svg.match(TEXT_ELEMENT);
  if (!textMatch) return null;

  const attrs = parseAttributes(textMatch[1]);
  const x = toNumber(attrs.x, 32.5);
  const baseline = toNumber(attrs.y, 231);
  const fontSize = toNumber(attrs['font-size'], 32);
  const fill = attrs.fill || 'white';
  // EthID keeps FE0F variation selectors in the name; ENS-normalized names do not have them.
  const label = decodeXmlEntities(textMatch[2]).trim().replace(/\uFE0F/g, '');

  const labelHtml = await renderLabel(label, instanceId);

  // Everything except the name: background, avatar, logo, embedded font, filter.
  let body = svg.replace(textMatch[0], '');
  body = namespaceSvgIds(body, instanceId);
  body = body.replace(
    /<svg\b[^>]*>/,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CARD_SIZE} ${CARD_SIZE}" width="100%" height="100%" ` +
      `preserveAspectRatio="xMidYMid slice" fill="none" style="display:block">`
  );

  const closing = body.lastIndexOf('</svg>');
  if (closing === -1) return null;

  const top = baseline - fontSize * BASELINE_TO_TOP_RATIO - 1;
  const overlay =
    `<foreignObject x="${x}" y="${top}" width="${CARD_SIZE - x}" height="${fontSize * 1.6}" overflow="visible" style="overflow:visible">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="font-family:'Satoshi',sans-serif;font-weight:bold;font-size:${fontSize}px;` +
    `line-height:1;color:${fill};white-space:nowrap;font-variant-ligatures:none;font-variant-numeric:tabular-nums;` +
    `font-feature-settings:'ss01' on,'ss03' on;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.225))">${labelHtml}</div>` +
    `</foreignObject>`;

  return body.slice(0, closing) + overlay + '</svg>';
}

/**
 * HTML for the name with each emoji swapped for an inline Apple emoji SVG.
 */
async function renderLabel(label: string, instanceId: string): Promise<string> {
  const escaped = escapeHtml(label);
  const withEmoji = await emojiMappingService.replaceEmojisWithSvg(escaped);

  let index = 0;
  return withEmoji.replace(/<svg\b[\s\S]*?<\/svg>/g, (emojiSvg) => {
    const styled = emojiSvg
      .replace(/\sclass="[^"]*"/, ` class="${EMOJI_CLASS}"`)
      .replace(/\sstyle="[^"]*"/, ` style="${EMOJI_STYLE}"`);
    return namespaceSvgIds(styled, `${instanceId}-e${index++}`);
  });
}

/**
 * Suffix every id in an SVG fragment (and the url(#id) / href="#id" references to
 * it) so multiple fragments can coexist in one document without clobbering each
 * other's gradients, filters and patterns.
 */
export function namespaceSvgIds(svg: string, suffix: string): string {
  const ids = Array.from(new Set(Array.from(svg.matchAll(/\bid="([^"]+)"/g), (m) => m[1])));
  let out = svg;
  for (const id of ids) {
    const safe = escapeRegExp(id);
    out = out
      .replace(new RegExp(`\\bid="${safe}"`, 'g'), `id="${id}-${suffix}"`)
      .replace(new RegExp(`url\\(#${safe}\\)`, 'g'), `url(#${id}-${suffix})`)
      .replace(new RegExp(`href="#${safe}"`, 'g'), `href="#${id}-${suffix}"`);
  }
  return out;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function toNumber(value: string | undefined, fallback: number): number {
  const parsed = parseFloat(value ?? '');
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
