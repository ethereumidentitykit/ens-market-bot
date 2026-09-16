/**
 * Render tweet images for arbitrary ENS names without the database or dashboard.
 *
 * Usage:
 *   npm run image:test -- vitalik.eth 🔥🔥🔥.eth nick.eth
 *   npm run image:test -- vitalik.eth --type registration
 *   npm run image:test -- a.eth b.eth c.eth d.eth --type renewal   (all names in one image)
 *   npm run image:test -- vitalik.eth --out /tmp/previews
 *
 * Sale, registration and bid produce one image per name. Renewal produces a single
 * image with the names as cards (first three shown, the rest counted as "+N more").
 * Without a database the price-tier lookup is skipped, so tier-1 templates are used.
 *
 * Browser: Puppeteer needs a Chrome build matching its pinned version. If that build
 * is not in the Puppeteer cache and PUPPETEER_EXECUTABLE_PATH is unset, this script
 * falls back to a locally installed Chrome. Otherwise run
 * `npx puppeteer browsers install chrome` once.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type ImageType = 'sale' | 'registration' | 'bid' | 'renewal';
const IMAGE_TYPES: ImageType[] = ['sale', 'registration', 'bid', 'renewal'];

const SYSTEM_CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

/**
 * Point Puppeteer at a system Chrome when its own managed build is missing.
 * Must run before anything imports `puppeteer`, which reads the env var on load.
 */
function configureBrowser(): void {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return;

  let pinnedVersion: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    pinnedVersion = require('puppeteer-core/lib/cjs/puppeteer/revisions.js').PUPPETEER_REVISIONS?.chrome;
  } catch {
    // Older/newer layouts: fall through and let Puppeteer resolve on its own
  }

  if (pinnedVersion) {
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
    const chromeDir = path.join(cacheDir, 'chrome');
    const hasManagedBuild =
      fs.existsSync(chromeDir) &&
      fs.readdirSync(chromeDir).some((entry) => entry.endsWith(`-${pinnedVersion}`));
    if (hasManagedBuild) return;
  }

  const systemChrome = SYSTEM_CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (systemChrome) {
    process.env.PUPPETEER_EXECUTABLE_PATH = systemChrome;
    console.log(`Using system Chrome: ${systemChrome}`);
  } else {
    console.warn('No Puppeteer-managed Chrome found and no system Chrome detected.');
    console.warn('Run `npx puppeteer browsers install chrome` or set PUPPETEER_EXECUTABLE_PATH.');
  }
}

function parseArgs(argv: string[]): { names: string[]; type: ImageType; outDir: string } {
  const names: string[] = [];
  let type: ImageType = 'sale';
  let outDir = 'data';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--type' || arg === '-t') {
      const value = argv[++i] as ImageType;
      if (!IMAGE_TYPES.includes(value)) {
        throw new Error(`Unknown --type "${value}". Expected one of: ${IMAGE_TYPES.join(', ')}`);
      }
      type = value;
    } else if (arg === '--out' || arg === '-o') {
      outDir = argv[++i];
      if (!outDir) throw new Error('--out requires a directory');
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}"`);
    } else {
      names.push(arg);
    }
  }

  if (names.length === 0) {
    printUsage();
    throw new Error('Pass at least one ENS name');
  }
  return { names, type, outDir };
}

function printUsage(): void {
  console.log('Usage: npm run image:test -- <name.eth> [more names...] [--type sale|registration|bid|renewal] [--out dir]');
}

/** Filesystem-safe fragment of an ENS name (emoji names collapse to underscores). */
function safeLabel(name: string): string {
  return name.replace(/[^a-z0-9.-]/gi, '_').slice(0, 40) || 'name';
}

async function main(): Promise<void> {
  const { names, type, outDir } = parseArgs(process.argv.slice(2));
  configureBrowser();

  // Imported after configureBrowser() so Puppeteer sees PUPPETEER_EXECUTABLE_PATH.
  const { PuppeteerImageService } = await import('../src/services/puppeteerImageService');
  const mock = PuppeteerImageService.getMockData();

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = Date.now();
  const written: string[] = [];

  const save = (label: string, buffer: Buffer) => {
    const file = path.resolve(outDir, `test-${type}-${label}-${stamp}.png`);
    fs.writeFileSync(file, buffer);
    written.push(file);
    console.log(`✅ ${file} (${buffer.length} bytes)`);
  };

  if (type === 'renewal') {
    const cards = names.map((ensName, i) => ({ ensName, costEth: 0.005 - i * 0.001 }));
    const topNames = cards.slice(0, 3);
    const buffer = await PuppeteerImageService.generateRenewalImage({
      totalCostEth: cards.reduce((sum, c) => sum + c.costEth, 0),
      totalCostUsd: cards.length * 12.5,
      nameCount: cards.length,
      topNames,
      extraCount: cards.length - topNames.length,
      renewerEns: mock.buyerEns || 'james.eth',
      renewerAvatar: mock.buyerAvatar,
      transactionHash: mock.transactionHash,
      timestamp: new Date()
    });
    save(safeLabel(names[0]) + (names.length > 1 ? `+${names.length - 1}` : ''), buffer);
  } else {
    for (const ensName of names) {
      console.log(`\n▶ Rendering ${type} image for ${ensName}`);
      let buffer: Buffer;
      if (type === 'registration') {
        buffer = await PuppeteerImageService.generateRegistrationImage({
          priceEth: mock.priceEth,
          priceUsd: mock.priceUsd,
          ensName,
          buyerEns: mock.buyerEns || 'james.eth',
          buyerAvatar: mock.buyerAvatar,
          sellerEns: 'ENS DAO',
          transactionHash: mock.transactionHash
        });
      } else if (type === 'bid') {
        buffer = await PuppeteerImageService.generateBidImage({ ...mock, ensName });
      } else {
        buffer = await PuppeteerImageService.generateSaleImage({ ...mock, ensName });
      }
      save(safeLabel(ensName), buffer);
    }
  }

  console.log(`\nDone: ${written.length} image(s) written to ${path.resolve(outDir)}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\n❌ ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
