require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalize } = require('viem/ens');

// These tests use local font/emoji assets and synthetic EthID artwork. No API,
// database, deployment credentials, or installed multilingual fonts are required.
const loggerPath = require.resolve('../src/utils/logger.ts');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: { logger: { debug() {}, info() {}, warn() {}, error() {} } },
};

const {
  CJK_FONT_FAMILY, IMAGE_FONT_FAMILIES, IMAGE_FONT_STACK, getImageFontCss, getImageTextLanguage, waitForImageFonts,
} = require('../src/services/imageFonts');
const { buildEthIdSvgCard } = require('../src/services/ethIdCardBuilder');
const { EthIdImageService } = require('../src/services/ethIdImageService');
const { PuppeteerImageService } = require('../src/services/puppeteerImageService');

// Each word is an ENS-valid label. Marks are intentional: coverage alone is
// insufficient unless Indic, Arabic, and Southeast Asian scripts also shape.
const LANGUAGE_SAMPLES = [
  ['Simplified Chinese', '孙宇晨', CJK_FONT_FAMILY],
  ['Traditional Chinese', '孫宇晨', CJK_FONT_FAMILY],
  ['Supplementary Han', '𠮷', CJK_FONT_FAMILY],
  ['Japanese hiragana', 'にほんご', CJK_FONT_FAMILY],
  ['Japanese katakana', 'カタカナ', CJK_FONT_FAMILY],
  ['Japanese kanji + kana', '日本語にほんご', CJK_FONT_FAMILY],
  ['Korean', '한국어', CJK_FONT_FAMILY],
  ['Thai', 'ภาษาไทย', 'ENS Noto Sans Thai'],
  ['Thai with tone mark', 'เก้า', 'ENS Noto Sans Thai'],
  ['Hindi', 'हिन्दी', 'ENS Noto Sans Devanagari'],
  ['Arabic with marks', 'عَرَبِيّ', 'ENS Noto Sans Arabic'],
  ['Hebrew', 'עברית', 'ENS Noto Sans Hebrew'],
  ['Bengali', 'বাংলা', 'ENS Noto Sans Bengali'],
  ['Tamil', 'தமிழ்', 'ENS Noto Sans Tamil'],
  ['Telugu', 'తెలుగు', 'ENS Noto Sans Telugu'],
  ['Kannada', 'ಕನ್ನಡ', 'ENS Noto Sans Kannada'],
  ['Malayalam', 'മലയാളം', 'ENS Noto Sans Malayalam'],
  ['Gujarati', 'ગુજરાતી', 'ENS Noto Sans Gujarati'],
  ['Gurmukhi', 'ਪੰਜਾਬੀ', 'ENS Noto Sans Gurmukhi'],
  ['Odia', 'ଓଡ଼ିଆ', 'ENS Noto Sans Oriya'],
  ['Sinhala', 'සිංහල', 'ENS Noto Sans Sinhala'],
  ['Lao', 'ລາວ', 'ENS Noto Sans Lao'],
  ['Khmer', 'ខ្មែរ', 'ENS Noto Sans Khmer'],
  ['Myanmar', 'မြန်မာ', 'ENS Noto Sans Myanmar'],
  ['Armenian', 'հայերեն', 'ENS Noto Sans Armenian'],
  ['Georgian', 'ქართული', 'ENS Noto Sans Georgian'],
  ['Ethiopic', 'አማርኛ', 'ENS Noto Sans Ethiopic'],
  ['Tibetan', 'བོད་ཡིག', 'ENS Noto Serif Tibetan'],
  ['Accented Latin', 'café', 'ENS Noto Sans'],
  ['Greek', 'ελληνικά', 'ENS Noto Sans'],
  ['Cyrillic', 'русский', 'ENS Noto Sans'],
].map(([language, label, family]) => ({ language, label, family }));

function svgCard(name, content = name) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 270 270">
    <style>text { font-family: 'Satoshi'; font-weight: bold; }</style>
    <defs><linearGradient id="background" x2="1" y2="1"><stop stop-color="#7588fa"/><stop offset="1" stop-color="#3db8e6"/></linearGradient></defs>
    <rect width="270" height="270" fill="url(#background)"/>
    <text x="24" y="240" font-size="24" fill="white">${content}</text>
  </svg>`;
}

function stubArtwork(t) {
  t.mock.method(EthIdImageService, 'fetchNftCard', async (name) => ({
    format: 'svg', source: 'fixture', html: await buildEthIdSvgCard(svgCard(name), name, 'test'),
  }));
}

function saleData(overrides = {}) {
  return {
    priceEth: 0.65, priceUsd: 1321.21, ensName: 'example.eth',
    buyerEns: 'buyer.eth', sellerEns: 'seller.eth',
    buyerAddress: '0x123', sellerAddress: '0x456',
    transactionHash: '0xabc', timestamp: new Date('2026-11-12T00:00:00Z'),
    ...overrides,
  };
}

function renewalData(names, overrides = {}) {
  return {
    totalCostEth: 0.65, totalCostUsd: 1321.21, costIsEthEquivalent: true,
    nameCount: names.length, topNames: names.map(ensName => ({ ensName, costEth: 0.65 })),
    extraCount: 0, renewerEns: 'owner.eth',
    transactionHash: '0xabc', timestamp: new Date('2026-11-12T00:00:00Z'),
    ...overrides,
  };
}

function assertBundledFont(html, families = [CJK_FONT_FAMILY]) {
  const sources = [...html.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)];
  assert.equal(sources.length, families.length, 'embed each needed font exactly once');
  for (const source of sources) {
    const binary = Buffer.from(source[1], 'base64');
    assert.equal(binary.subarray(0, 4).toString('ascii'), 'wOF2', 'include an actual WOFF2 asset');
  }
  const faces = [...html.matchAll(/@font-face\s*\{\s*font-family:\s*'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(faces.sort(), [...families].sort(), 'declare the expected script-specific font faces');
}

test('CJK font is embedded for Simplified, Traditional, and supplementary Han names', () => {
  for (const name of ['孙宇晨.eth', '孫宇晨.eth', '𠮷.eth', 'ーーー.eth']) {
    const css = getImageFontCss([name]);
    assertBundledFont(css);
    assert.ok(!/https?:/.test(css), 'Chinese glyphs must not depend on a font CDN');
  }
  assert.ok(!getImageFontCss(['vitalik.eth', '🔥.eth']).includes('data:font/woff2'),
    'Latin and SVG-emoji names should not carry the large CJK font');
});

test('ENS-valid language samples select their bundled fonts without network dependencies', () => {
  for (const { language, label, family } of LANGUAGE_SAMPLES) {
    assert.equal(normalize(`${label}.eth`), `${label}.eth`, `${language} sample must remain ENS-valid`);
    assert.ok(IMAGE_FONT_FAMILIES.includes(family), `${language} requires a registered font family`);
    const css = getImageFontCss([`${label}.eth`]);
    assertBundledFont(css, [family]);
    assert.ok(!/https?:/.test(css), `${language} must not depend on a font CDN`);
  }
  const names = LANGUAGE_SAMPLES.map(({ label }) => `${label}.eth`);
  assertBundledFont(getImageFontCss([...names, ...names]),
    [...new Set(LANGUAGE_SAMPLES.map(({ family }) => family))]);
});

test('multilingual names retain their script text when mixed with Apple emoji', async () => {
  for (const { language, label, family } of LANGUAGE_SAMPLES) {
    const name = `${label}🔥.eth`;
    const card = await buildEthIdSvgCard(svgCard(name), name, `mixed-${language.replace(/\W/g, '')}`);
    assert.ok(card && card.includes('<foreignObject'), `${language} emoji label should remain SVG-backed HTML`);
    assert.ok(card.includes(family), `${language} emoji label needs the same font fallback`);
    assert.ok(card.includes(label), `${language} text/marks must survive emoji replacement`);
    assert.ok(card.includes('class="nft-card-emoji"'), `${language} label should retain Apple emoji artwork`);
  }
});

test('kana and Hangul select localized CJK forms without guessing Han-only language', async () => {
  assert.equal(getImageTextLanguage('日本語にほんご.eth'), 'ja');
  assert.equal(getImageTextLanguage('カタカナ.eth'), 'ja');
  assert.equal(getImageTextLanguage('한국어.eth'), 'ko');
  assert.equal(getImageTextLanguage('東京.eth'), undefined);
  for (const [name, language] of [['日本語にほんご.eth', 'ja'], ['한국어.eth', 'ko']]) {
    const card = await buildEthIdSvgCard(svgCard(name), name, language);
    assert.ok(card.includes(`lang="${language}"`), 'SVG labels need an explicit locale for CJK shaping');
  }
});

test('Chinese SVG text and wrapped tspans retain their original name and positions', async () => {
  const name = '孙宇晨.eth';
  const card = await buildEthIdSvgCard(svgCard(name), name, 'chinese');
  assert.ok(card.includes('class="ethid-nft-card"'), 'SVG text needs the scoped fallback selector');
  assert.ok(card.includes('x="24" y="240" font-size="24"'), 'preserve EthID text positioning');
  assert.ok(card.includes(`>${name}</text>`), 'preserve the full Chinese name');
  assert.ok(!card.includes('<foreignObject'), 'ordinary Chinese text should stay SVG text');

  const first = '孙宇晨孫宇晨孙宇晨孫宇晨';
  const second = '孙宇晨孫宇晨孙宇晨.eth';
  const content = `<tspan x="24" dy="-0.6em">${first}</tspan><tspan x="24" dy="1.2em">${second}</tspan>`;
  const wrapped = await buildEthIdSvgCard(svgCard(first + second, content), first + second, 'wrapped');
  assert.ok(wrapped.includes(content), 'do not alter upstream line breaks or truncate CJK text');
  assert.ok(getImageFontCss([first + second]).includes('.ethid-nft-card tspan'),
    'wrapped text needs the same fallback as unwrapped labels');
});

test('mixed Chinese and emoji labels use bundled glyphs alongside Apple emoji SVGs', async () => {
  const name = '孙宇晨🔥.eth';
  const card = await buildEthIdSvgCard(svgCard(name), name, 'mixed');
  assert.ok(card, 'mixed names must not fall back to upstream PNG');
  assert.ok(card.includes('<foreignObject'), 'emoji labels use the HTML rendering path');
  assert.ok(card.includes(CJK_FONT_FAMILY), 'foreignObject text must explicitly use the CJK fallback');
  assert.ok(card.includes('孙宇晨') && card.includes('.eth'), 'preserve Chinese and Latin text');
  assert.ok(card.includes('class="nft-card-emoji"'), 'preserve the bundled Apple emoji');
  assert.ok(!card.includes('🔥'), 'emoji should be rendered as SVG rather than a missing font glyph');
});

test('sale, registration, and bid templates load CJK fonts for card and profile names', async t => {
  stubArtwork(t);
  for (const type of ['sale', 'registration', 'bid']) {
    for (const field of ['ensName', 'buyerEns', 'sellerEns']) {
      const html = await PuppeteerImageService.generateHTML(saleData({ [field]: '孙宇晨.eth' }), type);
      assertBundledFont(html);
    }
  }
});

test('renewals load the font for any visible card and for the renewer profile', async t => {
  stubArtwork(t);
  for (const names of [
    ['孙宇晨.eth'],
    ['example.eth', '孙宇晨.eth'],
    ['example.eth', '孙宇晨.eth', '孫宇晨.eth'],
  ]) {
    assertBundledFont(await PuppeteerImageService.generateRenewalHTML(renewalData(names)));
  }
  assertBundledFont(await PuppeteerImageService.generateRenewalHTML(
    renewalData(['example.eth'], { renewerEns: '孙宇晨.eth' })
  ));
});

test('transaction templates include every script needed by their card and profile names', async t => {
  stubArtwork(t);
  const data = saleData({ ensName: 'にほんご.eth', buyerEns: 'ภาษาไทย.eth', sellerEns: 'हिन्दी.eth' });
  const families = [CJK_FONT_FAMILY, 'ENS Noto Sans Thai', 'ENS Noto Sans Devanagari'];
  for (const type of ['sale', 'registration', 'bid']) {
    assertBundledFont(await PuppeteerImageService.generateHTML(data, type), families);
  }
  assertBundledFont(await PuppeteerImageService.generateRenewalHTML(
    renewalData(['にほんご.eth', 'हिन्दी.eth'], { renewerEns: 'ภาษาไทย.eth' })
  ), families);
});

// Run with IMAGE_FONT_BROWSER_TEST=1 and, if needed, PUPPETEER_EXECUTABLE_PATH.
// CDP verifies the font that actually drew each label: a local macOS/Windows CJK
// fallback must not conceal a missing font in the production Linux image.
test('browser renders Chinese labels offline with the bundled web font', {
  skip: process.env.IMAGE_FONT_BROWSER_TEST !== '1',
}, async t => {
  stubArtwork(t);
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 545 });
  await page.setRequestInterception(true);
  page.on('request', request => /^https?:/.test(request.url()) ? request.abort() : request.continue());

  const html = await PuppeteerImageService.generateRenewalHTML(
    renewalData(['孙宇晨.eth', '孫宇晨.eth', '孙🔥.eth'], { renewerEns: '孙宇晨.eth' })
  );
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await waitForImageFonts(page);

  const client = await page.createCDPSession();
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const isBundledFont = font => font.isCustomFont && /Noto Sans/.test(font.familyName);
  async function assertChineseGlyphs(selector, expectedGlyphs) {
    const { root } = await client.send('DOM.getDocument');
    const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `missing expected label: ${selector}`);
    const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
    const bundledGlyphs = fonts.filter(isBundledFont).reduce((count, font) => count + font.glyphCount, 0);
    assert.ok(bundledGlyphs >= expectedGlyphs,
      `${selector} did not draw enough bundled Chinese glyphs: ${JSON.stringify(fonts)}`);

    // Satoshi may draw `.eth`, whether installed or embedded. Inspect the same
    // element with only its Han characters to prove Noto draws the Chinese,
    // rather than letting its Latin glyphs conceal a system Chinese fallback.
    const original = await page.$eval(selector, element => {
      const markup = element.innerHTML;
      element.textContent = [...element.textContent].filter(char => /\p{Script=Han}/u.test(char)).join('');
      element.getBoundingClientRect(); // Flush layout before asking CDP which glyphs were drawn.
      return markup;
    });
    try {
      const { fonts: chineseFonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(chineseFonts.length > 0 && chineseFonts.every(isBundledFont),
        `${selector} used a system font for Chinese: ${JSON.stringify(chineseFonts)}`);
      assert.equal(chineseFonts.reduce((count, font) => count + font.glyphCount, 0), expectedGlyphs);
    } finally {
      await page.$eval(selector, (element, markup) => {
        element.innerHTML = markup;
        element.getBoundingClientRect();
      }, original);
    }
  }
  for (const [selector, expectedGlyphs] of [
    ['.renewal-card:nth-child(1) text', 3],
    ['.renewal-card:nth-child(2) text', 3],
    ['.renewal-card:nth-child(3) foreignObject div', 1],
    ['.renewer-name', 3],
  ]) {
    await assertChineseGlyphs(selector, expectedGlyphs);
  }
  if (process.env.IMAGE_FONT_PREVIEW_PATH) {
    await page.screenshot({ path: process.env.IMAGE_FONT_PREVIEW_PATH, type: 'png' });
  }

  const first = '孙宇晨孫宇晨孙宇晨孫宇晨';
  const second = '孙宇晨孫宇晨孙宇晨.eth';
  const content = `<tspan x="24" dy="-0.6em">${first}</tspan><tspan x="24" dy="1.2em">${second}</tspan>`;
  const wrapped = await buildEthIdSvgCard(svgCard(first + second, content), first + second, 'wrapped');
  const supplementary = await buildEthIdSvgCard(svgCard('𠮷.eth'), '𠮷.eth', 'supplementary');
  await page.setContent(`<style>${getImageFontCss([first + second, '𠮷.eth'])}</style>
    <div class="wrapped" style="width:270px;height:270px">${wrapped}</div>
    <div class="supplementary" style="width:270px;height:270px">${supplementary}</div>`,
    { waitUntil: 'domcontentloaded' });
  await waitForImageFonts(page);
  await assertChineseGlyphs('.wrapped tspan:nth-child(1)', 12);
  await assertChineseGlyphs('.wrapped tspan:nth-child(2)', 9);
  await assertChineseGlyphs('.supplementary text', 1);
});

test('browser renders multilingual SVG, emoji, and profile labels using bundled fonts offline', {
  skip: process.env.IMAGE_FONT_BROWSER_TEST !== '1',
}, async t => {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 545 });
  await page.setRequestInterception(true);
  page.on('request', request => /^https?:/.test(request.url()) ? request.abort() : request.continue());
  const client = await page.createCDPSession();
  await client.send('DOM.enable');
  await client.send('CSS.enable');
  const previews = [];

  for (const [index, { language, label, family }] of LANGUAGE_SAMPLES.entries()) {
    // Remove `.eth` only from the fixture's visible text so CDP reports the
    // script under test. Latin suffixes can legitimately use Satoshi/Inter.
    const plain = await buildEthIdSvgCard(svgCard(label), `${label}.eth`, `plain-${index}`);
    const mixed = await buildEthIdSvgCard(svgCard(`${label}🔥`), `${label}🔥.eth`, `mixed-${index}`);
    const languageAttribute = getImageTextLanguage(label);
    const lang = languageAttribute ? `lang="${languageAttribute}"` : '';
    // Satoshi may already cover accented Latin, Greek, and Cyrillic on a
    // developer's machine. Explicitly exercise their bundled fallback face.
    const baseFontProbe = family === 'ENS Noto Sans'
      ? `.plain text,.mixed foreignObject div {font-family:'${family}' !important;}`
      : '';
    await page.setContent(`<style>
      ${getImageFontCss([label])}
      body {margin:24px;background:#111827;color:white;font-family:Arial,sans-serif;}
      .samples {display:flex;gap:20px;align-items:center;}
      .plain,.mixed {width:270px;height:270px;flex-shrink:0;}
      .profile {font-family:${IMAGE_FONT_STACK};font-size:32px;line-height:1.8;}
      ${baseFontProbe}
      </style><h1>${language}</h1><div class="samples">
      <div class="plain">${plain}</div><div class="mixed">${mixed}</div>
      <div class="profile" ${lang}>${label}</div></div>`, { waitUntil: 'domcontentloaded' });
    await waitForImageFonts(page);
    const { root } = await client.send('DOM.getDocument');
    for (const selector of ['.plain text', '.mixed foreignObject div', '.profile']) {
      const { nodeId } = await client.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      assert.ok(nodeId, `${language}: missing ${selector}`);
      const { fonts } = await client.send('CSS.getPlatformFontsForNode', { nodeId });
      assert.ok(fonts.length > 0 && fonts.every(font =>
        font.isCustomFont && font.familyName.startsWith(family.replace(/^ENS /, ''))),
      `${language} ${selector} used a system or unexpected font: ${JSON.stringify(fonts)}`);
      // Glyph counts deliberately vary for ligatures and combining marks.
      assert.ok(fonts.reduce((count, font) => count + font.glyphCount, 0) > 0,
        `${language} ${selector} produced no visible glyphs`);
    }
    previews.push(`<section><h2>${language}</h2><div class="preview-card">${plain}</div>
      <div class="preview-label" ${lang}>${label}</div></section>`);
  }

  if (process.env.IMAGE_FONT_LANGUAGES_PREVIEW_PATH) {
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setContent(`<style>
      ${getImageFontCss(LANGUAGE_SAMPLES.map(({ label }) => label))}
      * {box-sizing:border-box;}
      body {margin:0;padding:28px;background:#111827;color:#f8fafc;font-family:Arial,sans-serif;}
      h1 {margin:0 0 8px;font-size:30px;}p {margin:0 0 28px;color:#cbd5e1;}
      main {display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:20px;}
      section {background:#1e293b;border:1px solid #334155;border-radius:14px;padding:14px;}
      h2 {font-size:16px;font-weight:400;margin:0 0 12px;color:#cbd5e1;}
      .preview-card {width:100%;aspect-ratio:1;border-radius:10px;overflow:hidden;}
      .preview-label {font-family:${IMAGE_FONT_STACK};font-size:24px;line-height:1.9;margin-top:6px;}
      </style><h1>ENS image font checks</h1>
      <p>Local font rendering with external requests blocked · SVG card + profile text · ${LANGUAGE_SAMPLES.length} ENS-valid samples</p>
      <main>${previews.join('')}</main>`, { waitUntil: 'domcontentloaded' });
    await waitForImageFonts(page);
    await page.screenshot({ path: process.env.IMAGE_FONT_LANGUAGES_PREVIEW_PATH, type: 'png', fullPage: true });
  }
});
