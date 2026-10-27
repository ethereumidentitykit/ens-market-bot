import { logger } from '../utils/logger';
import { ImageData, RenewalImageData } from '../types/imageTypes';
import { IDatabaseService } from '../types';
import { emojiMappingService } from './emojiMappingService';
import { RealImageData } from './realDataImageService';
import { EthIdImageService } from './ethIdImageService';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import type { Browser, Page } from 'puppeteer-core';

export class PuppeteerImageService {
  private static readonly IMAGE_WIDTH = 1000;
  private static readonly IMAGE_HEIGHT = 545;

  /**
   * Generate ENS registration image using Puppeteer
   */
  public static async generateRegistrationImage(data: RealImageData, databaseService?: IDatabaseService): Promise<Buffer> {
    // Convert RealImageData to ImageData format for compatibility
    const mockData: ImageData = {
      priceEth: data.priceEth,
      priceUsd: data.priceUsd,
      currencySymbol: data.currencySymbol,
      ensName: data.ensName,
      buyerAddress: '0x0000000000000000000000000000000000000000', // Placeholder
      buyerEns: data.buyerEns, // New owner
      buyerAvatar: data.buyerAvatar,
      sellerAddress: '0x0000000000000000000000000000000000000000', // Placeholder
      sellerEns: data.sellerEns, // "ENS DAO"
      sellerAvatar: this.getDaoProfileBase64(), // Use DAO avatar for registrations
      transactionHash: data.transactionHash || '0x0000',
      timestamp: new Date()
    };

    return await this.generateImageWithBackground(mockData, 'registration', databaseService);
  }

  /**
   * Generate ENS sale image using Puppeteer
   */
  public static async generateSaleImage(data: ImageData, databaseService?: IDatabaseService): Promise<Buffer> {
    return await this.generateImageWithBackground(data, 'sale', databaseService);
  }

  /**
   * Generate ENS bid image using Puppeteer
   */
  public static async generateBidImage(data: ImageData, databaseService?: IDatabaseService): Promise<Buffer> {
    return await this.generateImageWithBackground(data, 'bid', databaseService);
  }

  /**
   * Generate ENS renewal image using Puppeteer.
   *
   * Renewals use a fundamentally different layout from sales/regs/bids:
   * - Left side: total tx cost (USD + ETH) and "Owner" profile (renewer)
   * - Right side: dynamic grid of name cards (1, 2, 3, or 4+ layouts)
   *
   * Tier background (renewal-t1..t4.png) is selected by total USD cost via DB price tiers.
   * The "RENEWED" badge and "Owner" label are baked into the background PNGs.
   */
  public static async generateRenewalImage(
    data: RenewalImageData,
    databaseService?: IDatabaseService
  ): Promise<Buffer> {
    return await this.generateRenewalImageInternal(data, databaseService);
  }

  /**
   * Generate image with specified background type
   */
  private static async generateImageWithBackground(
    data: ImageData, 
    imageType: 'sale' | 'registration' | 'bid', 
    databaseService?: IDatabaseService
  ): Promise<Buffer> {
    // Environment-aware Puppeteer setup
    const isVercel = process.env.VERCEL === '1';
    
    let browser: any; // Using any due to dynamic import type conflicts between puppeteer and puppeteer-core
    
    if (isVercel) {
      // Use Vercel-specific Chromium setup
      const puppeteer = await import('puppeteer-core');
      const chromium = await import('@sparticuz/chromium');
      
      browser = await puppeteer.default.launch({
        args: chromium.default.args,
        executablePath: await chromium.default.executablePath(),
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
      });
    } else {
      // Use regular Puppeteer for VPS and local development
      const puppeteer = await import('puppeteer');
      
      browser = await puppeteer.default.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      });
    }

    try {
      const page: Page = await browser.newPage();
      
      // Set viewport to match our image dimensions
      await page.setViewport({
        width: this.IMAGE_WIDTH,
        height: this.IMAGE_HEIGHT,
        deviceScaleFactor: 1
      });

      // Generate HTML content with emoji replacement and background type
      const htmlContent = await this.generateHTML(data, imageType, databaseService);
      logger.debug(`Generated HTML content length: ${htmlContent.length} chars`);
      
      // Set the HTML content
      const contentStartTime = Date.now();
      await page.setContent(htmlContent, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 // Increased timeout to 30s but using faster wait condition
      });
      logger.debug(`Page content loaded in ${Date.now() - contentStartTime}ms`);

      // Wait for fonts to actually load instead of arbitrary delay
      const fontLoadStart = Date.now();
      try {
        // Check if fonts are loaded using document.fonts API with fallback timeout
        await Promise.race([
          // Wait for fonts to be ready
          page.evaluate(() => {
            return new Promise<void>((resolve) => {
              if (document.fonts.status === 'loaded') {
                resolve();
              } else {
                document.fonts.addEventListener('loadingdone', () => resolve());
                document.fonts.ready.then(() => resolve());
              }
            });
          }),
          // Safety timeout of 2 seconds
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
        const fontLoadTime = Date.now() - fontLoadStart;
        logger.debug(`Fonts loaded in ${fontLoadTime}ms (smart detection), proceeding with image generation`);
      } catch (error) {
        logger.warn('Font loading detection failed, using 300ms fallback delay');
        await new Promise(resolve => setTimeout(resolve, 300));
        const fallbackTime = Date.now() - fontLoadStart;
        logger.debug(`Font fallback delay complete in ${fallbackTime}ms`);
      }

      // Smart Korean font loading detection
      const koreanFontStart = Date.now();
      try {
        await Promise.race([
          // Test if Korean characters render properly
          page.evaluate(() => {
            return new Promise<void>((resolve) => {
              const testKoreanFont = () => {
                // Create canvas to test character rendering
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                if (!ctx) return false;
                
                // Test with Korean character
                ctx.font = '16px "Noto Sans KR", sans-serif';
                const koreanWidth = ctx.measureText('한').width;
                
                // Test with fallback
                ctx.font = '16px sans-serif';
                const fallbackWidth = ctx.measureText('한').width;
                
                // If widths differ significantly, Korean font is loaded
                return Math.abs(koreanWidth - fallbackWidth) > 1;
              };
              
              if (testKoreanFont()) {
                resolve();
              } else {
                const checkFont = () => {
                  if (testKoreanFont()) {
                    resolve();
                  } else {
                    setTimeout(checkFont, 50);
                  }
                };
                setTimeout(checkFont, 50);
              }
            });
          }),
          // 1 second timeout for Korean font
          new Promise(resolve => setTimeout(resolve, 1000))
        ]);
        const koreanFontTime = Date.now() - koreanFontStart;
        logger.debug(`Korean font loaded in ${koreanFontTime}ms (smart detection)`);
      } catch (error) {
        logger.debug(`Korean font detection timeout, proceeding with screenshot...`);
      }

      // Text fitting for main template buyer/seller names
      await page.evaluate(() => {
        const fitText = (selector: string, maxSize: number, minSize: number) => {
          const elements = document.querySelectorAll(selector);
          elements.forEach((element: any) => {
            const parent = element.parentElement;
            if (!parent) return;
            
            let size = maxSize;
            element.style.fontSize = size + 'px';
            
            // Keep reducing size while text overflows and we're above minimum
            while (element.scrollWidth > parent.clientWidth && size > minSize) {
              size -= 0.5;
              element.style.fontSize = size + 'px';
            }
          });
        };
        
        // Fit buyer and seller names in main template
        fitText('.buyer-name, .seller-name', 24, 16);
      });

      // Take screenshot
      const screenshot = await page.screenshot({
        type: 'png',
        clip: {
          x: 0,
          y: 0,
          width: this.IMAGE_WIDTH,
          height: this.IMAGE_HEIGHT
        }
      });

      logger.info('Successfully generated image with Puppeteer');
      return screenshot as Buffer;

    } catch (error) {
      logger.error('Error generating image with Puppeteer:', error);
      throw error;
    } finally {
      await browser.close();
    }
  }

  // ============================================================================
  // Renewal image generation (separate pipeline from generateImageWithBackground
  // because the layout — dynamic 1/2/3/4+ card grid — is fundamentally different).
  // ============================================================================

  /**
   * Pick the renewal background tier (renewal-t1.png .. renewal-t4.png) based on
   * the total tx USD cost. Mirrors getTemplatePath() but for the 'renewals'
   * transaction type. Falls back to T1 if no DB or unparseable USD.
   */
  private static async getRenewalTemplatePath(
    totalCostUsd: number,
    databaseService?: IDatabaseService
  ): Promise<string> {
    let tier = 1;
    if (databaseService && totalCostUsd > 0) {
      try {
        const priceTier = await databaseService.getPriceTierForAmount('renewals', totalCostUsd);
        if (priceTier) {
          tier = priceTier.tierLevel;
          logger.info(`Selected renewals tier ${tier} for $${totalCostUsd.toFixed(2)} USD`);
        }
      } catch (error) {
        logger.error('Error determining renewal price tier:', error);
      }
    }
    const templatePath = `assets/image-templates/renewals/renewal-t${tier}.png`;
    logger.info(`Using renewal template: ${templatePath}`);
    return templatePath;
  }

  /**
   * Internal: launches Puppeteer, builds the renewal HTML, takes the screenshot.
   * Same Vercel/local launch dance as generateImageWithBackground(), so kept
   * separate but parallel — no shared method because the HTML differs heavily.
   */
  private static async generateRenewalImageInternal(
    data: RenewalImageData,
    databaseService?: IDatabaseService
  ): Promise<Buffer> {
    const isVercel = process.env.VERCEL === '1';

    let browser: any;
    if (isVercel) {
      const puppeteer = await import('puppeteer-core');
      const chromium = await import('@sparticuz/chromium');
      browser = await puppeteer.default.launch({
        args: chromium.default.args,
        executablePath: await chromium.default.executablePath(),
        headless: true,
        ignoreDefaultArgs: ['--disable-extensions'],
      });
    } else {
      const puppeteer = await import('puppeteer');
      browser = await puppeteer.default.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu'
        ]
      });
    }

    try {
      const page: Page = await browser.newPage();
      await page.setViewport({
        width: this.IMAGE_WIDTH,
        height: this.IMAGE_HEIGHT,
        deviceScaleFactor: 1
      });

      const htmlContent = await this.generateRenewalHTML(data, databaseService);
      logger.debug(`Generated renewal HTML content length: ${htmlContent.length} chars`);

      await page.setContent(htmlContent, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Wait for fonts to load (same pattern as generateImageWithBackground)
      try {
        await Promise.race([
          page.evaluate(() => {
            return new Promise<void>((resolve) => {
              if (document.fonts.status === 'loaded') {
                resolve();
              } else {
                document.fonts.addEventListener('loadingdone', () => resolve());
                document.fonts.ready.then(() => resolve());
              }
            });
          }),
          new Promise(resolve => setTimeout(resolve, 2000))
        ]);
      } catch {
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // Auto-shrink long renewer names so they fit next to the avatar.
      // (Card names are baked into the NFT art itself — no HTML name labels to fit.)
      await page.evaluate(() => {
        const fitText = (selector: string, maxSize: number, minSize: number) => {
          const elements = document.querySelectorAll(selector);
          elements.forEach((element: any) => {
            const parent = element.parentElement;
            if (!parent) return;
            let size = maxSize;
            element.style.fontSize = size + 'px';
            while (element.scrollWidth > parent.clientWidth - 16 && size > minSize) {
              size -= 0.5;
              element.style.fontSize = size + 'px';
            }
          });
        };
        fitText('.renewer-name', 24, 16);
      });

      const screenshot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: this.IMAGE_WIDTH, height: this.IMAGE_HEIGHT }
      });

      logger.info('Successfully generated renewal image with Puppeteer');
      return screenshot as Buffer;

    } catch (error) {
      logger.error('Error generating renewal image with Puppeteer:', error);
      throw error;
    } finally {
      await browser.close();
    }
  }

  /**
   * Build the HTML for a renewal image.
   *
   * Layout strategy (option b — dynamic grid):
   *   1 name  → 1 large card (445×475px) filling the right half
   *   2 names → 2 tall cards (215×475px) side by side
   *   3 names → 3 slim cards (145×475px) in a row
   *   4+ names → 2×2 grid of 215×215px cards (top 3 + "+N more" overflow)
   *
   * Each card shows: ENS NFT image (or placeholder) on top, full name on bottom.
   * The "+N more" overflow card is a visually distinct variant in the bottom-right slot.
   */
  private static async generateRenewalHTML(
    data: RenewalImageData,
    databaseService?: IDatabaseService
  ): Promise<string> {
    const templatePath = await this.getRenewalTemplatePath(data.totalCostUsd, databaseService);
    const backgroundImageBase64 = this.loadAsBase64(templatePath);
    const userPlaceholderBase64 = this.loadAsBase64('assets/image-templates/user.png');
    const ensPlaceholderBase64 = this.loadAsBase64('assets/image-templates/ens.png');

    const templateImagePath = `data:image/png;base64,${backgroundImageBase64}`;
    const ensPlaceholderDataUri = `data:image/png;base64,${ensPlaceholderBase64}`;

    // ----- Left side: prices and renewer profile -----

    const formattedUsdPrice = this.formatPrice(data.totalCostUsd);
    const formattedEthPrice = this.formatEthPrice(data.totalCostEth);

    // Renewer avatar
    let renewerAvatarPath = `data:image/png;base64,${userPlaceholderBase64}`;
    if (data.renewerAvatar) {
      const remote = await this.loadRemoteImageAsBase64(data.renewerAvatar);
      if (remote) renewerAvatarPath = remote;
    }

    // Emoji-process the renewer name (display name may include emojis like 'vitalik.eth')
    let renewerEnsWithEmojis = data.renewerEns || 'unknown';
    try {
      renewerEnsWithEmojis = await emojiMappingService.replaceEmojisWithSvg(renewerEnsWithEmojis);
    } catch (error) {
      logger.warn(`Failed to process emojis in renewer name: ${error}`);
    }

    // ----- Right side: cards -----
    //
    // Each card's visual is THE NFT CARD ITSELF — the ENS NFT art already contains
    // the logo and name, so no HTML label is needed. The card comes from the EthID
    // metadata service as inline SVG with the bot's Apple emoji (or EthID's PNG as
    // fallback); if EthID cannot serve the name, the ens.png placeholder is used.
    const resolvedCards = await Promise.all(
      data.topNames.map(async (card) => {
        const nftCard = await EthIdImageService.fetchNftCard(card.ensName);
        if (!nftCard) {
          logger.warn(`EthID NFT image unavailable for renewal card ${card.ensName}, using placeholder`);
        }
        return { html: nftCard?.html ?? `<img src="${ensPlaceholderDataUri}" alt="ENS NFT">` };
      })
    );

    // Layout selection — based on TOTAL visible cards (NFT cards + overflow card if any).
    //
    //   visibleCards = topNames.length + (extraCount > 0 ? 1 : 0)
    //
    // Layouts:
    //   1 visible      → single big square card (~445×445)
    //   2 visible      → 2 squares side-by-side, vertically centered
    //   3 visible (3 NFTs, no overflow) → 2x2 grid with bottom-right empty
    //   4 visible (3 NFTs + overflow, OR 4 NFTs)  → 2x2 grid with all cells filled
    //
    // All cards are SQUARE (aspect-ratio 1:1) so that background-size: cover doesn't
    // crop important parts of the NFT art (the .eth NFT itself is square).
    const visibleCards = data.topNames.length + (data.extraCount > 0 ? 1 : 0);
    const layoutClass =
      visibleCards === 1 ? 'layout-1' :
      visibleCards === 2 ? 'layout-2' :
      'layout-2x2'; // 3 or 4 visible cards → 2x2 grid (3-card case leaves bottom-right empty)

    // Render the NFT cards. Each cell clips its child (inline SVG, PNG or placeholder)
    // to a rounded square; the child fills the cell (see .renewal-card > svg/img).
    const dataCardsHtml = resolvedCards.map((card) => `
      <div class="renewal-card">${card.html}</div>
    `).join('');

    // Overflow card ("+N more") is the ONLY HTML-rendered card — it's not an NFT, just a count.
    // It always lands in the bottom-right cell of the 2x2 grid because it's appended last.
    const overflowCardHtml = data.extraCount > 0 ? `
      <div class="renewal-card renewal-card-overflow">
        <div class="renewal-card-overflow-text">+${data.extraCount}<br>more</div>
      </div>
    ` : '';

    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ENS Renewal Image</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }

            body {
                width: ${this.IMAGE_WIDTH}px;
                height: ${this.IMAGE_HEIGHT}px;
                font-family: 'Inter', 'Noto Sans KR', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', Arial, sans-serif;
                overflow: hidden;
                position: relative;
                background: #1E1E1E;
            }

            .canvas {
                position: relative;
                width: ${this.IMAGE_WIDTH}px;
                height: ${this.IMAGE_HEIGHT}px;
            }

            /* Background Template (RENEWED badge + Owner label baked in) */
            .background {
                position: absolute;
                top: 0; left: 0;
                width: 100%; height: 100%;
                background-image: url("${templateImagePath}");
                background-size: cover;
                background-position: center;
                background-repeat: no-repeat;
            }

            /* USD Price (left side, centred horizontally on left half) */
            .usd-price {
                position: absolute;
                left: 250px;
                top: 210px;
                transform: translate(-50%, -50%);
                text-align: center;
                color: white;
                font-size: 85px;
                font-weight: 600;
            }

            /* ETH Price */
            .eth-price {
                position: absolute;
                left: 250px;
                top: 305px;
                transform: translate(-50%, -50%);
                text-align: center;
                color: white;
                font-size: 48px;
                font-weight: normal;
            }

            .eth-price.equivalent-price {
                width: 450px;
            }
            .eth-price .equivalent-label {
                display: block;
                font-size: 22px;
                line-height: 1.2;
            }

            /* Owner profile (avatar + ENS name) — positioned to mirror the Figma reference
               for the renewal layout (NOT the registration .buyer-section, which is
               right-anchored). The "Owner" label is baked into the background PNG and
               ends around x=145; the avatar+name flow rightward starting just after.
               Layout: [avatar] [name] (avatar on the left, name following). */
            .renewer-section {
                position: absolute;
                left: 162px;
                top: 477px;
                transform: translateY(-50%);
                display: flex;
                align-items: center;
                gap: 10px;
                max-width: 320px;  /* Cap width so really long names don't run off the canvas */
            }

            .renewer-avatar {
                width: 36px;
                height: 36px;
                border-radius: 50%;
                object-fit: cover;
                flex-shrink: 0;
            }

            .renewer-name {
                color: white;
                font-size: 24px;
                font-weight: normal;
                white-space: nowrap;
                overflow: hidden;
                font-family: 'Inter', 'Noto Sans KR', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', Arial, sans-serif;
            }

            /* ----- Cards container (right side of the image) -----
               Anchored to the same area as the registration template's .ens-nft
               (which uses 500/45 with 455×455). We use a flex layout so we can
               vertically/horizontally center smaller card configurations within the
               available right-half region instead of stretching them. */
            .cards-container {
                position: absolute;
                top: 35px;
                left: 500px;
                width: 460px;
                height: 475px;
                display: flex;
                align-items: center;     /* vertically center the inner grid */
                justify-content: center; /* horizontally center the inner grid */
            }

            /* Inner grid — actual cells live here. Sizing varies per layout. */
            .cards-grid {
                display: grid;
                gap: 18px;
            }

            /* Layout: 1 visible card → single big square (~445×445) */
            .cards-grid.layout-1 {
                grid-template-columns: 445px;
                grid-template-rows: 445px;
            }

            /* Layout: 2 visible cards → 2 squares side-by-side (each ~221×221) */
            .cards-grid.layout-2 {
                grid-template-columns: 221px 221px;
                grid-template-rows: 221px;
            }

            /* Layout: 3 OR 4 visible cards → 2x2 grid of squares (each ~221×221).
               Total: 460×460 (which fits the 460×475 container with vertical breathing room).
               When only 3 cards are present (3 NFTs, no overflow), the bottom-right cell is
               left empty — matching the design intent (visually consistent square grid). */
            .cards-grid.layout-2x2 {
                grid-template-columns: 221px 221px;
                grid-template-rows: 221px 221px;
            }

            /* Each renewal card IS the NFT card (inline SVG or <img> child).
               No HTML overlay — the NFT art already contains the ENS logo + name (it's
               part of the rendered .eth NFT artwork, same as the registration template).
               aspect-ratio is enforced by the explicit cell sizing above so cover-cropping
               doesn't distort the square NFT art. */
            .renewal-card {
                background-color: #2a3990;  /* Faint fallback while the card loads */
                border-radius: 19px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                overflow: hidden;
            }
            .renewal-card > svg,
            .renewal-card > img {
                display: block;
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            /* Overflow card ("+N more") — only HTML-styled card. Placed last in the cards
               array so the row-major grid puts it in the bottom-right cell of the 2x2 layout.
               (For 3-NFT/no-overflow case, this element isn't rendered → bottom-right stays empty.) */
            .renewal-card-overflow {
                background-color: transparent;
                background-image: linear-gradient(135deg, #5a8ee0 0%, #7aabff 100%);
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .renewal-card-overflow-text {
                color: white;
                font-size: 38px;
                font-weight: 700;
                line-height: 1.05;
                text-align: center;
                text-shadow: 0 1px 2px rgba(0,0,0,0.3);
            }

            /* Emoji SVG styling (inline emojis in names) */
            .emoji-inline {
                display: inline-block !important;
                vertical-align: middle !important;
                width: 1.2em !important;
                height: 1.2em !important;
                margin: 0 0.1em !important;
            }
        </style>
    </head>
    <body>
        <div class="canvas">
            <div class="background"></div>

            <div class="usd-price">${formattedUsdPrice}</div>
            <div class="eth-price${data.costIsEthEquivalent ? ' equivalent-price' : ''}">${data.costIsEthEquivalent ? '~' : ''}${formattedEthPrice} ETH${data.costIsEthEquivalent ? ' <span class="equivalent-label">equivalent</span>' : ''}</div>

            <div class="renewer-section">
                <img src="${renewerAvatarPath}" alt="Renewer" class="renewer-avatar"
                     onerror="this.src='data:image/png;base64,${userPlaceholderBase64}'">
                <div class="renewer-name">${renewerEnsWithEmojis}</div>
            </div>

            <div class="cards-container">
                <div class="cards-grid ${layoutClass}">
                    ${dataCardsHtml}
                    ${overflowCardHtml}
                </div>
            </div>
        </div>
    </body>
    </html>`;

    return html;
  }

  /**
   * Load image file as base64 string (local files only)
   */
  private static loadAsBase64(imagePath: string): string {
    try {
      const imageBuffer = fs.readFileSync(path.join(process.cwd(), imagePath));
      return imageBuffer.toString('base64');
    } catch (error) {
      logger.error(`Failed to load image from ${imagePath}:`, error);
      // Return a 1x1 transparent pixel as fallback
      return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    }
  }

  /**
   * Load remote image URL as base64 data URL
   */
  private static async loadRemoteImageAsBase64(imageUrl: string, timeoutMs: number = 10000): Promise<string | null> {
    try {
      logger.debug(`Loading avatar: ${imageUrl.substring(0, 100)}...`);
      
      // If it's already a data URL, return it as-is
      if (imageUrl.startsWith('data:')) {
        logger.debug(`Avatar is already a data URL, using as-is`);
        return imageUrl;
      }
      
      // Only proceed if we have a valid HTTP/HTTPS URL
      if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
        logger.warn(`Invalid avatar URL protocol: ${imageUrl.substring(0, 100)}...`);
        return null;
      }
      
      const response = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: timeoutMs, // Use configurable timeout
        headers: {
          'User-Agent': 'ENS-TwitterBot/1.0'
        }
      });

      const imageBuffer = Buffer.from(response.data);
      
      // Detect image type from response headers
      const contentType = response.headers['content-type'] || 'image/png';
      
      // For regular avatar images (PNG, JPG, etc.), convert to base64
      const base64 = imageBuffer.toString('base64');
      logger.debug(`Successfully loaded avatar: ${imageUrl} (${contentType})`);
      return `data:${contentType};base64,${base64}`;
      
    } catch (error: any) {
      logger.warn(`Failed to load remote image ${imageUrl}:`, error.message);
      return null;
    }
  }

  /**
   * Format price string with proper comma separators (whole numbers only)
   */
  private static formatPrice(priceUsd: string | number): string {
    // Convert to string and remove existing formatting
    const cleanPrice = priceUsd.toString().replace(/[$,]/g, '');
    const numericPrice = parseFloat(cleanPrice);
    
    // Return formatted price with commas and dollar sign (rounded to whole number)
    if (!isNaN(numericPrice)) {
      const roundedPrice = Math.round(numericPrice);
      return '$' + roundedPrice.toLocaleString('en-US');
    }
    
    // Return original if parsing fails
    return priceUsd.toString();
  }

  /**
   * Format ETH value to 2 decimal places
   */
  private static formatEthPrice(priceEth: string | number): string {
    const numericPrice = parseFloat(priceEth.toString());
    
    // Return formatted ETH price with 2 decimal places
    if (!isNaN(numericPrice)) {
      return numericPrice.toFixed(2);
    }
    
    // Return original if parsing fails
    return priceEth.toString();
  }

  /**
   * Get dynamic template path based on transaction type and price tier
   */
  private static async getTemplatePath(
    data: ImageData, 
    imageType: 'sale' | 'registration' | 'bid',
    databaseService?: IDatabaseService
  ): Promise<string> {
    
    // Convert imageType to database transaction type
    const transactionTypeMap = {
      'sale': 'sales',
      'registration': 'registrations', 
      'bid': 'bids'
    } as const;
    
    const transactionType = transactionTypeMap[imageType];
    
    // Default to T1 if no database service available
    let tier = 1;
    
    if (databaseService && data.priceUsd) {
      try {
        // Extract numeric value from price string (e.g., "$1,269" -> 1269)
        const priceString = data.priceUsd.toString().replace(/[$,]/g, '');
        const priceNumeric = parseFloat(priceString);
        
        if (!isNaN(priceNumeric)) {
          // Query database for price tier
          const priceTier = await databaseService.getPriceTierForAmount(transactionType, priceNumeric);
          if (priceTier) {
            tier = priceTier.tierLevel;
            logger.info(`Selected ${transactionType} tier ${tier} for $${priceNumeric} USD`);
          }
        }
      } catch (error) {
        logger.error('Error determining price tier:', error);
        // Fall back to T1 on error
      }
    }
    
    // Build template path based on transaction type and tier
    const typeMap = {
      'sales': 'sale',
      'registrations': 'reg',
      'bids': 'bid'
    } as const;
    
    // Map transaction types to actual directory names
    const directoryMap = {
      'sales': 'sales',
      'registrations': 'regs',
      'bids': 'bids'
    } as const;
    
    const basename = typeMap[transactionType];
    const directoryName = directoryMap[transactionType];
    const templatePath = `assets/image-templates/${directoryName}/${basename}-t${tier}.png`;
    
    logger.info(`Using template: ${templatePath}`);
    return templatePath;
  }

  /**
   * Generate HTML template with embedded CSS - NEW EXACT POSITIONING WITH DYNAMIC TEMPLATES
   */
  private static async generateHTML(
    data: ImageData, 
    imageType: 'sale' | 'registration' | 'bid' = 'sale',
    databaseService?: IDatabaseService
  ): Promise<string> {
    
    // Get dynamic template path based on transaction type and price tier
    const templatePath = await this.getTemplatePath(data, imageType, databaseService);
    
    // Load actual template images as base64
    const backgroundImageBase64 = this.loadAsBase64(templatePath);
    const userPlaceholderBase64 = this.loadAsBase64('assets/image-templates/user.png');
    const ensPlaceholderBase64 = this.loadAsBase64('assets/image-templates/ens.png');
    
    // Format USD price with commas
    const formattedUsdPrice = this.formatPrice(data.priceUsd);
    
    // Use actual images or fallbacks
    const templateImagePath = `data:image/png;base64,${backgroundImageBase64}`;
    
    // ENS NFT card from the EthID metadata service: inline SVG with the bot's Apple
    // emoji (or EthID's PNG as fallback). The bundled ens.png placeholder is used if
    // EthID cannot serve the name.
    let nftCardHtml = `<img src="data:image/png;base64,${ensPlaceholderBase64}" alt="ENS NFT">`;
    const nftCard = await EthIdImageService.fetchNftCard(data.ensName);
    if (nftCard) {
      nftCardHtml = nftCard.html;
    } else {
      logger.warn(`❌ EthID NFT image unavailable for ${data.ensName}, using placeholder`);
    }
    
    // Convert avatar URLs to base64 data URLs (SEQUENTIAL to prevent resource exhaustion)
    let sellerAvatarPath = `data:image/png;base64,${userPlaceholderBase64}`;
    if (data.sellerAvatar) {
      logger.debug(`Processing seller avatar: ${data.sellerAvatar.substring(0, 100)}...`);
      const sellerAvatarBase64 = await this.loadRemoteImageAsBase64(data.sellerAvatar);
      if (sellerAvatarBase64) {
        sellerAvatarPath = sellerAvatarBase64;
        logger.debug(`Loaded seller avatar successfully (${sellerAvatarBase64.length} chars)`);
      }
    }
    
    let buyerAvatarPath = `data:image/png;base64,${userPlaceholderBase64}`;
    if (data.buyerAvatar) {
      logger.debug(`Processing buyer avatar: ${data.buyerAvatar.substring(0, 100)}...`);
      const buyerAvatarBase64 = await this.loadRemoteImageAsBase64(data.buyerAvatar);
      if (buyerAvatarBase64) {
        buyerAvatarPath = buyerAvatarBase64;
        logger.debug(`Loaded buyer avatar successfully: ${data.buyerAvatar}`);
      }
    }
    
    // Replace emojis in text fields with SVG elements (with error handling)
    let ensNameWithEmojis = data.ensName;
    // When owner/seller lookup fails, show 'unknown' for all transaction types
    let sellerEnsWithEmojis = data.sellerEns || 'unknown';
    let buyerEnsWithEmojis = data.buyerEns || 'buyer';
    
        logger.info(`🏷️ Processing emojis in names:`);
    logger.info(`  📛 ENS: "${data.ensName}"`);
    logger.info(`  👤 Seller: "${data.sellerEns || 'unknown'}"`);  
    logger.info(`  🛒 Buyer: "${data.buyerEns || 'buyer'}"`);  
    
    try {
      ensNameWithEmojis = await emojiMappingService.replaceEmojisWithSvg(data.ensName);
      logger.info(`✅ ENS name emoji processing: "${data.ensName}" -> ${ensNameWithEmojis.length} chars`);
      if (ensNameWithEmojis !== data.ensName) {
        logger.info(`  🔄 Emojis were replaced in ENS name`);
      } else {
        logger.info(`  ⏸️ No emojis found in ENS name`);
      }
    } catch (error) {
      logger.error(`❌ Failed to process ENS name emojis for "${data.ensName}":`, error);
    }
    
    try {
      sellerEnsWithEmojis = await emojiMappingService.replaceEmojisWithSvg(data.sellerEns || 'unknown');
      logger.info(`✅ Seller emoji processing: "${data.sellerEns}" -> ${sellerEnsWithEmojis.length} chars`);
      if (sellerEnsWithEmojis !== (data.sellerEns || 'unknown')) {
        logger.info(`  🔄 Emojis were replaced in seller name`);
      }
    } catch (error) {
      logger.error(`❌ Failed to process seller emojis for "${data.sellerEns}":`, error);
    }
    
    try {
      buyerEnsWithEmojis = await emojiMappingService.replaceEmojisWithSvg(data.buyerEns || 'buyer');
      logger.info(`✅ Buyer emoji processing: "${data.buyerEns}" -> ${buyerEnsWithEmojis.length} chars`);
      
      
      if (buyerEnsWithEmojis !== (data.buyerEns || 'buyer')) {
        logger.info(`  🔄 Emojis were replaced in buyer name`);
      }
    } catch (error) {
      logger.error(`❌ Failed to process buyer emojis for "${data.buyerEns}":`, error);
    }
    
    const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ENS Transaction Image</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;600;700&family=Noto+Sans+Arabic:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                width: ${this.IMAGE_WIDTH}px;
                height: ${this.IMAGE_HEIGHT}px;
                font-family: 'Inter', 'Noto Sans KR', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', Arial, sans-serif;
                overflow: hidden;
                position: relative;
                background: #1E1E1E;
            }

            .canvas {
                position: relative;
                width: ${this.IMAGE_WIDTH}px;
                height: ${this.IMAGE_HEIGHT}px;
            }

            /* Background Template */
            .background {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background-image: url("${templateImagePath}");
                background-size: cover;
                background-position: center;
                background-repeat: no-repeat;
            }

            /* ENS NFT card (Right Side) — clips its child (inline SVG, PNG or placeholder) */
            .ens-nft {
                position: absolute;
                left: 500px;
                top: 45px;
                width: 455px;
                height: 455px;
                border-radius: 19px;
                overflow: hidden;
            }
            .ens-nft > svg,
            .ens-nft > img {
                display: block;
                width: 100%;
                height: 100%;
                object-fit: cover;
            }

            /* USD Price (Left Side - Center Aligned) */
            .usd-price {
                position: absolute;
                left: 250px;
                top: 210px;
                transform: translate(-50%, -50%);
                text-align: center;
                color: white;
                font-size: 85px;
                font-weight: 600;
                font-family: 'Inter', 'Noto Sans KR', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', Arial, sans-serif;
            }

            /* ETH Price (Left Side - Center Aligned) */
            .eth-price {
                position: absolute;
                left: 250px;
                top: 305px;
                transform: translate(-50%, -50%);
                text-align: center;
                color: white;
                font-size: 48px;
                font-weight: normal;
                font-family: 'Inter', 'Noto Sans KR', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', Arial, sans-serif;
            }

            /* Seller Section (Dynamic Positioning) */
            .seller-section {
                position: absolute;
                right: 545px;
                top: ${imageType === 'registration' ? '390px' : '477px'}; /* Bottom for sales/bids, top for regs */
                transform: translateY(-50%);
                display: flex;
                align-items: center;
                flex-direction: row-reverse;
            }

            .seller-name {
                color: white;
                font-size: 24px;
                font-weight: normal;
                white-space: nowrap;
                margin-left: 8px;
                font-family: 'Inter', 'Noto Sans KR', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', Arial, sans-serif;
            }

            .seller-avatar {
                width: 50px;
                height: 50px;
                border-radius: 50%;
                object-fit: cover;
            }

            /* Buyer Section (Dynamic Positioning) */
            .buyer-section {
                position: absolute;
                right: 545px;
                top: ${imageType === 'registration' ? '477px' : '390px'}; /* Bottom for regs (no seller), top for sales/bids */
                transform: translateY(-50%);
                display: flex;
                align-items: center;
                flex-direction: row-reverse;
            }

            .buyer-name {
                color: white;
                font-size: 24px;
                font-weight: normal;
                white-space: nowrap;
                margin-left: 8px;
                font-family: 'Inter', 'Noto Sans KR', 'Noto Sans Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Malgun Gothic', 'Apple SD Gothic Neo', Arial, sans-serif;
            }

            .buyer-avatar {
                width: 50px;
                height: 50px;
                border-radius: 50%;
                object-fit: cover;
            }

            /* Emoji SVG styling */
            .emoji-inline {
                display: inline-block !important;
                vertical-align: middle !important;
                width: 1.2em !important;
                height: 1.2em !important;
                margin: 0 0.1em !important;
            }
        </style>
    </head>
    <body>
        <div class="canvas">
            <!-- Background Template -->
            <div class="background"></div>

            <!-- ENS NFT card (EthID SVG with Apple emoji, or PNG / placeholder fallback) -->
            <div class="ens-nft">${nftCardHtml}</div>

            <!-- USD Price -->
            <div class="usd-price">
                ${formattedUsdPrice}
            </div>

            <!-- ETH Price -->
            <div class="eth-price">
                ${this.formatEthPrice(data.priceEth)} ${data.currencySymbol || 'ETH'}
            </div>

            ${imageType !== 'registration' ? `
            <!-- Seller Section -->
            <div class="seller-section">
                <div class="seller-name">${sellerEnsWithEmojis}</div>
                <img src="${sellerAvatarPath}" alt="Seller" class="seller-avatar" onerror="this.src='data:image/png;base64,${userPlaceholderBase64}'">
            </div>
            ` : ''}

            <!-- Buyer Section -->
            <div class="buyer-section">
                <div class="buyer-name">${buyerEnsWithEmojis}</div>
                <img src="${buyerAvatarPath}" alt="Buyer" class="buyer-avatar" onerror="this.src='data:image/png;base64,${userPlaceholderBase64}'">
            </div>
        </div>
    </body>
    </html>`;
    
    
    return html;
  }

  /**
   * Get background image as base64 data URL
   */
  private static getBackgroundImageBase64(): string | null {
    try {
      const backgroundPath = path.join(__dirname, '../../assets/background.png');
      if (fs.existsSync(backgroundPath)) {
        const imageBuffer = fs.readFileSync(backgroundPath);
        const base64Image = imageBuffer.toString('base64');
        return `data:image/png;base64,${base64Image}`;
      }
    } catch (error) {
      logger.warn('Failed to load background image for base64 conversion:', error);
    }
    return null;
  }

  /**
   * Get registration background image as base64 data URL
   */
  private static getRegistrationBackgroundImageBase64(): string | null {
    try {
      const backgroundPath = path.join(__dirname, '../../assets/background-reg.png');
      if (fs.existsSync(backgroundPath)) {
        const imageBuffer = fs.readFileSync(backgroundPath);
        const base64Image = imageBuffer.toString('base64');
        return `data:image/png;base64,${base64Image}`;
      }
    } catch (error) {
      logger.warn('Failed to load registration background image for base64 conversion:', error);
      // Fallback to regular background
      return this.getBackgroundImageBase64();
    }
    return null;
  }

  /**
   * Get user placeholder image as base64 data URL
   */
  private static getUserPlaceholderBase64(): string | null {
    try {
      const placeholderPath = path.join(__dirname, '../../assets/userplaceholder.png');
      if (fs.existsSync(placeholderPath)) {
        const imageBuffer = fs.readFileSync(placeholderPath);
        const base64Image = imageBuffer.toString('base64');
        return `data:image/png;base64,${base64Image}`;
      }
    } catch (error) {
      logger.warn('Failed to load user placeholder image for base64 conversion:', error);
    }
    return null;
  }

  /**
   * Get DAO profile image as base64 data URL
   */
  private static getDaoProfileBase64(): string | undefined {
    try {
      const daoProfilePath = path.join(__dirname, '../../assets/dao-profile.png');
      if (fs.existsSync(daoProfilePath)) {
        const imageBuffer = fs.readFileSync(daoProfilePath);
        const base64Image = imageBuffer.toString('base64');
        return `data:image/png;base64,${base64Image}`;
      }
    } catch (error) {
      logger.warn('Failed to load DAO profile image for base64 conversion:', error);
      // Fallback to user placeholder
      const fallback = this.getUserPlaceholderBase64();
      return fallback || undefined;
    }
    return undefined;
  }

  /**
   * Save image buffer to database or file (environment-aware)
   */
  public static async saveImageToFile(buffer: Buffer, filename: string, databaseService?: IDatabaseService): Promise<string> {
    // Only store in database on Vercel (serverless), use filesystem on VPS
    if (databaseService && process.env.VERCEL === '1') {
      try {
        await databaseService.storeGeneratedImage(filename, buffer);
        logger.info(`Image stored in database: ${filename}`);
        return `/api/images/${filename}`;
      } catch (error) {
        logger.error('Failed to store image in database, falling back to local file:', error);
        // Fall through to file storage as backup
      }
    }
    
    // VPS and local development: store as file
    const dataDir = path.join(process.cwd(), 'data');
    
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    const filePath = path.join(dataDir, filename);
    fs.writeFileSync(filePath, buffer);
    
    logger.info(`Image saved to: ${filePath}`);
    return filePath;
  }

  /**
   * Get mock data for testing
   */
  public static getMockData(): ImageData {
    return {
      priceEth: 5.51,
      priceUsd: 22560.01,
      ensName: 'name.eth', // Back to simple name for blue pill display
      buyerAddress: '0x1234567890abcdef1234567890abcdef12345678',
      buyerEns: 'james.eth',
      buyerAvatar: 'https://metadata.ens.domains/mainnet/avatar/vitalik.eth',
      sellerAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
      sellerEns: 'maxi.eth', 
      sellerAvatar: 'https://metadata.ens.domains/mainnet/avatar/brantly.eth',
      transactionHash: '0xtest123456789abcdef',
      timestamp: new Date()
    };
  }
}
