/// <reference lib="es2022.intl" />
import { emojiMappingService } from './emojiMappingService';

/**
 * Turns an EthID NFT card SVG into inline markup whose emoji use the bot's
 * bundled Apple emoji instead of whatever font the rendering machine has.
 *
 * EthID (see metadata.ethid.org) serves two layouts. Both embed a Satoshi
 * @font-face and draw the name as plain <text>:
 *   - ENSv1: 270×270, gradient or avatar background, drop-shadowed logo and name.
 *     A name over 25 characters is split into two <tspan> lines.
 *   - ENSv2: 518×518, weave or avatar background, with a badge and name label in
 *     a scaled <g>. Its text is painted with single-stop gradients, and long
 *     names and subnames wrap across several <text> elements.
 * (Unknown names are detected by EthIdImageService before the SVG reaches this
 * builder.)
 *
 * Emoji inside <text> are plain Unicode, so they need a local emoji font, and
 * Vercel's Chromium has none. Each <text> holding an emoji is swapped, where it
 * stands, for a <foreignObject> per line with the same position, size and font
 * whose emoji are inline Apple emoji SVGs. Everything else stays as EthID drew it,
 * in the card's own coordinate system.
 *
 * Every emoji ENS accepts has a bundled SVG (tests/emoji-mapping-service.test.cjs
 * holds us to that). ENS also accepts symbols such as ★ and ♪, which are not emoji:
 * nothing bundled can draw them and production has no font for them, so a card
 * holding one uses EthID's PNG, which draws its own symbols and Twemoji.
 *
 * All ids (EthID's gradients and filters, and the ids inside each emoji SVG) are
 * suffixed per instance so several cards can share one HTML page.
 */

const ROOT_TAG = /<svg\b([^>]*)>/;
const TEXT_ELEMENT = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
const TSPAN_ELEMENT = /<tspan\b([^>]*)>([^<]*)<\/tspan>/g;

/**
 * Text only an emoji font can draw: what EthID itself treats as an emoji, plus
 * what is left of a sequence with no bundled SVG once its parts are replaced
 * (skin tones, joiners, keycap marks). \p{Emoji} would also match plain digits.
 */
const EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|[\u200D\u20E3]/u;

/**
 * Sizing for the inline emoji SVGs so they sit on the text baseline like glyphs
 * and advance exactly 1em, the width EthID fits names to. Replaces the generic
 * style emojiMappingService attaches (1.2em, middle-aligned).
 * The emoji also get their own class: the tweet-image templates style
 * `.emoji-inline` globally with !important (1.2em boxes plus side margins for
 * names in the HTML overlay), which would push a long emoji name off the card.
 */
const EMOJI_STYLE = 'display:inline-block;width:1em;height:1em;vertical-align:-0.12em';
const EMOJI_CLASS = 'nft-card-emoji';

/**
 * Mirrors the text rules of EthID's embedded stylesheet, which only target <text>.
 * Its text-autospace:no-autospace needs no copy: that is already Chromium's default.
 */
const LABEL_STYLE =
  "font-family:'Satoshi',sans-serif;font-weight:bold;line-height:1;white-space:nowrap;" +
  "font-variant-ligatures:none;font-variant-numeric:tabular-nums;font-feature-settings:'ss01' on,'ss03' on";

/**
 * Distance in em from the top of a line-height:1 box to the baseline in Satoshi
 * Bold: its ascent (1.01) less half of its excess height over 1em ((1.01 + 0.24 - 1) / 2).
 */
const BASELINE_OFFSET_EM = 0.885;

/** Effects on a line's <text> that its replacement keeps: V1's shadow and faded subname parent. */
const INHERITED_ATTRIBUTES = ['filter', 'opacity'];

/** One line of a label, in the card's coordinates. */
interface LabelRow {
  x: number;
  baseline: number;
  label: string;
}

/**
 * Build the inline card markup for a name. Returns null for an SVG this builder
 * cannot reproduce faithfully, so the caller can use EthID's PNG instead.
 */
export async function buildEthIdSvgCard(svg: string, name: string, instanceId: string): Promise<string | null> {
  const { viewBox } = parseAttributes(svg.match(ROOT_TAG)?.[1] ?? '');
  if (!viewBox || !svg.trimEnd().endsWith('</svg>')) return null;

  let card = namespaceSvgIds(svg, instanceId).replace(
    ROOT_TAG,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="100%" height="100%" ` +
      `preserveAspectRatio="xMidYMid slice" fill="none" style="display:block">`
  );

  const texts = Array.from(card.matchAll(TEXT_ELEMENT));
  if (texts.length === 0) return null;

  for (const [index, text] of texts.entries()) {
    const markup = await renderText(text, card, name, `${instanceId}-t${index}`);
    if (!markup) return null;
    card = card.replace(text[0], () => markup);
  }
  return card;
}

/**
 * The markup for one <text>: unchanged unless it holds an emoji, otherwise a
 * <foreignObject> per line laying the label out in HTML. Returns null when a
 * label holding an emoji cannot be reproduced.
 */
async function renderText(
  [element, rawAttributes, content]: RegExpMatchArray,
  card: string,
  name: string,
  instanceId: string
): Promise<string | null> {
  // U+FFFD is an emoji EthID cut in half (see splitLongName).
  const text = decodeXmlEntities(content);
  if (!EMOJI.test(text) && !text.includes('\uFFFD')) return element;

  const attributes = parseAttributes(rawAttributes);
  const fontSize = parseFloat(attributes['font-size']);
  const color = resolveSolidColor(attributes.fill, card);
  const rows = parseRows(attributes, content, fontSize, name);
  if (!rows || !color) return null;

  const effects = INHERITED_ATTRIBUTES.filter((name) => attributes[name])
    .map((name) => ` ${name}="${attributes[name]}"`)
    .join('');

  let markup = '';
  for (const [index, { x, baseline, label }] of rows.entries()) {
    if (![x, baseline, fontSize].every(Number.isFinite)) return null;

    const labelHtml = await renderLabel(label, `${instanceId}-r${index}`);
    // Any emoji left in the markup has no bundled SVG, and production has no font to draw it.
    if (EMOJI.test(labelHtml)) return null;

    // Overflow stays visible because glyphs can rise above a line-height:1 box and would be clipped.
    markup +=
      `<foreignObject x="${x}" y="${baseline - fontSize * BASELINE_OFFSET_EM}" width="100%" height="100%" overflow="visible"${effects}>` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="${LABEL_STYLE};font-size:${fontSize}px;color:${color}">${labelHtml}</div>` +
      `</foreignObject>`;
  }
  return markup;
}

/**
 * The lines of a <text>: itself, or the two <tspan>s of a V1 name too long for one
 * line, whose `dy` offsets are in em from the line before. Returns null for any
 * other markup.
 */
function parseRows(
  attributes: Record<string, string>,
  content: string,
  fontSize: number,
  name: string
): LabelRow[] | null {
  let baseline = parseFloat(attributes.y);
  if (!content.includes('<')) {
    return [{ x: parseFloat(attributes.x), baseline, label: cleanLabel(content) }];
  }

  const spans = Array.from(content.matchAll(TSPAN_ELEMENT));
  if (spans.length !== 2 || content.replace(TSPAN_ELEMENT, '').trim()) return null;

  const labels = splitLongName(name, cleanLabel(spans.map(([, , text]) => text).join('')));
  return spans.map(([, rawSpan], index) => {
    const span = parseAttributes(rawSpan);
    baseline += parseFloat(span.dy) * fontSize;
    return { x: parseFloat(span.x), baseline, label: labels[index] };
  });
}

/**
 * The two lines of a long V1 name. EthID cuts it by UTF-16 position, so an emoji
 * name gets one short line and one that runs off the card, and an emoji on the cut
 * is lost. This halves the real name by character, which is what EthID's font size
 * assumes. Its text (`shownText`) still tells how much of a name over 60 characters
 * to show around the ellipsis.
 */
function splitLongName(name: string, shownText: string): [string, string] {
  // The labels of a subname have a <text> of their own.
  const characters = toCharacters(cleanLabel(name.split('.').slice(-2).join('.')));
  const [start, end] = shownText.split('...');
  const shown =
    end === undefined
      ? characters
      : [...characters.slice(0, toCharacters(start).length), '...', ...characters.slice(-toCharacters(end).length)];

  const middle = Math.floor(shown.length / 2);
  return [shown.slice(0, middle).join(''), shown.slice(middle).join('')];
}

/** Text as a reader sees its characters, with each emoji sequence whole. */
function toCharacters(text: string): string[] {
  return Array.from(new Intl.Segmenter().segment(text), ({ segment }) => segment);
}

/**
 * A line as ENS spells it. EthID keeps FE0F variation selectors, which normalized
 * names do not have, and leaves U+FFFD where it cuts a long name through an emoji.
 */
function cleanLabel(text: string): string {
  return decodeXmlEntities(text).replace(/[\uFE0F\uFFFD]/g, '');
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
 * The CSS colour for an SVG fill. HTML text cannot reference a paint server, so
 * a gradient reference resolves to its colour when it has only one stop. Returns
 * null for any other gradient, or when the fill is missing.
 */
function resolveSolidColor(fill: string | undefined, card: string): string | null {
  if (!fill) return null;

  const paintServerId = fill.match(/^url\(#(.+)\)$/)?.[1];
  if (!paintServerId) return fill;

  const gradient = card.match(
    new RegExp(`<linearGradient\\b[^>]*\\bid="${escapeRegExp(paintServerId)}"[^>]*>([\\s\\S]*?)</linearGradient>`)
  );
  const stops = Array.from((gradient?.[1] ?? '').matchAll(/\bstop-color="([^"]+)"/g), (stop) => stop[1]);
  return stops.length === 1 ? stops[0] : null;
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
