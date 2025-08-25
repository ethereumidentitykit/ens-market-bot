import { logger } from './logger';

/**
 * Utility for converting SVG to PNG using Puppeteer
 */
export class SvgConverter {
  /**
   * Convert SVG to PNG using Puppeteer for accurate rendering of custom fonts and emojis
   */
  public static async convertSvgToPng(svgContent: string): Promise<Buffer> {
    const startTime = Date.now();
    logger.debug(`Starting SVG to PNG conversion (${svgContent.length} chars)`);
    
    // Environment-aware Puppeteer setup
    const isVercel = process.env.VERCEL === '1';
    
    let browser;
    
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
      const page = await browser.newPage();
      await page.setViewport({ width: 270, height: 270 });
      
      // Clean SVG rendering - emojis already processed by emojiMappingService
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              body {
                margin: 0;
                padding: 0;
                width: 270px;
                height: 270px;
                display: flex;
                align-items: center;
                justify-content: center;
                background: transparent;
              }
              .svg-container {
                width: 270px;
                height: 270px;
              }
            </style>
          </head>
          <body>
            <div class="svg-container">
              ${svgContent}
            </div>
          </body>
        </html>
      `;
      
      await page.setContent(html);
      
      // Wait for SVG content to be ready
      await page.waitForSelector('.svg-container');
      
      // Short delay for SVG content to be ready 
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Take screenshot
      const screenshot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: 270, height: 270 }
      });
      
      await browser.close();
      const duration = Date.now() - startTime;
      logger.info(`Successfully converted SVG to PNG using Puppeteer (${duration}ms)`);
      
      return Buffer.from(screenshot);
    } catch (error) {
      if (browser) {
        await browser.close();
      }
      logger.error('Failed to convert SVG to PNG with Puppeteer:', error);
      throw error;
    }
  }
}
