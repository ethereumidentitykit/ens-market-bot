import * as fs from 'fs';
import * as path from 'path';
import type { Page } from 'puppeteer-core';

// A private family name prevents an installed font from hiding a missing asset.
export const CJK_FONT_FAMILY = 'ENS Noto Sans CJK';

interface ImageFont {
  family: string;
  file: string;
  matches: (text: string) => boolean;
}

const scriptFont = (script: string, name = script, style = 'Sans'): ImageFont => {
  const pattern = new RegExp(`\\p{Script=${script}}`, 'u');
  return {
    family: `ENS Noto ${style} ${name}`,
    file: `Noto${style}${name}-Regular.woff2`,
    matches: (text) => pattern.test(text)
  };
};

const IMAGE_FONTS: ImageFont[] = [
  {
    family: 'ENS Noto Sans',
    file: 'NotoSans-Regular.woff2',
    // Keep plain ASCII/emoji cards small, while covering accented Latin and
    // Greek/Cyrillic characters not present in EthID's Satoshi font.
    matches: (text) => /[\p{Script=Greek}\p{Script=Cyrillic}]/u.test(text) ||
      Array.from(text).some((char) => char.codePointAt(0)! > 0x7f && /\p{Script_Extensions=Latin}/u.test(char))
  },
  {
    family: CJK_FONT_FAMILY,
    file: 'NotoSansCJKsc-Regular.woff2',
    // Script_Extensions also catches shared kana marks such as ー (U+30FC).
    matches: (text) => /[\p{Script=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script=Hangul}]/u.test(text)
  },
  ...[
    'Thai', 'Devanagari', 'Arabic', 'Hebrew', 'Bengali', 'Tamil', 'Telugu',
    'Kannada', 'Malayalam', 'Gujarati', 'Gurmukhi', 'Oriya', 'Sinhala',
    'Lao', 'Khmer', 'Myanmar', 'Armenian', 'Georgian', 'Ethiopic'
  ].map((script) => scriptFont(script)),
  scriptFont('Tibetan', 'Tibetan', 'Serif')
];

export const IMAGE_FONT_FAMILIES = IMAGE_FONTS.map((font) => font.family);
export const IMAGE_FONT_STACK = IMAGE_FONT_FAMILIES.map((family) => `'${family}'`).join(',');
export const NFT_FONT_STACK = `'Satoshi',${IMAGE_FONT_STACK},sans-serif`;
export const UI_FONT_STACK = `'Inter',${IMAGE_FONT_STACK},-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif`;

const fontCache = new Map<string, string>();

/** Kana and Hangul provide an unambiguous hint for the CJK font's localized forms. */
export function getImageTextLanguage(text: string): 'ja' | 'ko' | undefined {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) return 'ja';
  if (/\p{Script=Hangul}/u.test(text)) return 'ko';
  // Han-only names could be Chinese or Japanese; do not guess their language.
  return undefined;
}

/**
 * Supply script fonts locally; production Chromium cannot rely on system fonts.
 * Embed each font once per page, only when a displayed name needs it. Preserve
 * shaping tables for connected letters, combining marks, and Indic conjuncts.
 */
export function getImageFontCss(texts: string[]): string {
  const cardCss = `.ethid-nft-card text, .ethid-nft-card tspan { font-family: ${NFT_FONT_STACK}; }`;
  const faces = IMAGE_FONTS.filter((font) => texts.some(font.matches)).map((font) => {
    let base64 = fontCache.get(font.file);
    if (!base64) {
      base64 = fs.readFileSync(path.join(process.cwd(), 'assets/fonts', font.file)).toString('base64');
      fontCache.set(font.file, base64);
    }
    return `
    @font-face {
      font-family: '${font.family}';
      src: url(data:font/woff2;base64,${base64}) format('woff2');
      font-style: normal;
      font-weight: 400;
      font-display: block;
    }`;
  });
  return `${faces.join('\n')}\n${cardCss}`;
}

/** Wait for every bundled font before fitting text or taking a screenshot. */
export async function waitForImageFonts(page: Page): Promise<void> {
  await page.evaluate(async (families) => {
    const fonts: FontFace[] = [];
    document.fonts.forEach((font) => fonts.push(font));
    const bundled = fonts.filter((font) => families.includes(font.family.replace(/['"]/g, '')));
    // A corrupt/missing embedded font must fail rendering rather than post tofu.
    await Promise.all(bundled.map((font) => font.load()));

    // Keep the bounded wait for the optional remote UI font. The script fonts
    // above are embedded, so their readiness never depends on that timeout.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, 2000); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }, IMAGE_FONT_FAMILIES);
}
