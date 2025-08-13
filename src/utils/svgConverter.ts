import { logger } from './logger';

/**
 * Utility for converting SVG to PNG using Puppeteer
 */
export class SvgConverter {
  /**
   * Convert SVG to PNG using Puppeteer for accurate rendering of custom fonts and emojis
   */
  public static async convertSvgToPng(svgContent: string): Promise<Buffer> {
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
      
      // Create a data URL from the SVG
      const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svgContent).toString('base64')}`;
      
      // Navigate to a simple HTML page with the SVG
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
              }
              img {
                width: 270px;
                height: 270px;
                object-fit: contain;
              }
            </style>
          </head>
          <body>
            <img src="${svgDataUrl}" alt="ENS Image" />
          </body>
        </html>
      `;
      
      await page.setContent(html);
      
      // Wait for image to load
      await page.waitForSelector('img');
      await (page as any).evaluate(() => {
        return new Promise((resolve) => {
          const img = document.querySelector('img');
          if (img && (img as any).complete) {
            resolve(true);
          } else if (img) {
            (img as any).onload = () => resolve(true);
            (img as any).onerror = () => resolve(true);
          } else {
            resolve(true);
          }
        });
      });
      
      // Small delay to ensure fonts are loaded
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Take screenshot
      const screenshot = await page.screenshot({
        type: 'png',
        clip: { x: 0, y: 0, width: 270, height: 270 }
      });
      
      await browser.close();
      logger.info('Successfully converted SVG to PNG using Puppeteer');
      
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
