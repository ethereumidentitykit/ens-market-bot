import { logger } from '../utils/logger';
import { MockImageData } from '../types/imageTypes';
import { IDatabaseService } from '../types';
import { emojiMappingService } from './emojiMappingService';
import * as fs from 'fs';
import * as path from 'path';

export class PuppeteerImageService {
  private static readonly IMAGE_WIDTH = 1000;
  private static readonly IMAGE_HEIGHT = 666;

  /**
   * Generate ENS sale image using Puppeteer
   */
  public static async generateSaleImage(data: MockImageData): Promise<Buffer> {
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
      
      // Set viewport to match our image dimensions
      await page.setViewport({
        width: this.IMAGE_WIDTH,
        height: this.IMAGE_HEIGHT,
        deviceScaleFactor: 1
      });

      // Generate HTML content with emoji replacement
      const htmlContent = await this.generateHTML(data);
      
      // Set the HTML content
      await page.setContent(htmlContent, { 
        waitUntil: 'networkidle0',
        timeout: 10000 
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

  /**
   * Generate HTML template with embedded CSS
   */
  private static async generateHTML(data: MockImageData): Promise<string> {
    // Get background image as base64 if it exists
    const backgroundImageBase64 = this.getBackgroundImageBase64();
    const userPlaceholderBase64 = this.getUserPlaceholderBase64();
    
    // Replace emojis in text fields with SVG elements
    const ensNameWithEmojis = await emojiMappingService.replaceEmojisWithSvg(data.ensName);
    const sellerEnsWithEmojis = await emojiMappingService.replaceEmojisWithSvg(data.sellerEns || 'seller');
    const buyerEnsWithEmojis = await emojiMappingService.replaceEmojisWithSvg(data.buyerEns || 'buyer');
    
    return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ENS Sale Image</title>
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                width: ${this.IMAGE_WIDTH}px;
                height: ${this.IMAGE_HEIGHT}px;
                font-family: Arial, sans-serif;
                overflow: hidden;
                position: relative;
                background: #1E1E1E;
                ${backgroundImageBase64 ? `background-image: url(${backgroundImageBase64});` : ''}
                background-size: cover;
                background-position: center;
            }

            .container {
                width: 100%;
                height: 100%;
                position: relative;
            }

            /* Price Section (Left Side) */
            .price-section {
                position: absolute;
                left: 270px;
                top: 80px;
                text-align: center;
                color: white;
                transform: translateX(-50%);
            }

            .eth-price {
                font-size: 120px;
                font-weight: bold;
                line-height: 1;
                text-shadow: 0px 0px 50px rgba(255, 255, 255, 0.25);
                margin-bottom: 10px;
            }

            .eth-label {
                font-size: 40px;
                text-shadow: 0px 0px 50px rgba(255, 255, 255, 0.25);
                margin-bottom: 20px;
            }

            .usd-price {
                font-size: 80px;
                font-weight: bold;
                text-shadow: 0px 0px 50px rgba(255, 255, 255, 0.25);
                margin-bottom: 10px;
            }

            .usd-label {
                font-size: 40px;
                text-shadow: 0px 0px 50px rgba(255, 255, 255, 0.25);
            }

            /* ENS Image Section (Right Side) */
            .ens-image-section {
                position: absolute;
                left: 552px;
                top: 48px;
                width: 400px;
                height: 400px;
            }

            .ens-image {
                width: 100%;
                height: 100%;
                border-radius: 30px;
                object-fit: cover;
                box-shadow: 0px 0px 50px rgba(0, 0, 0, 0.4);
            }

            .ens-placeholder {
                width: 100%;
                height: 100%;
                background: #4496E7;
                border-radius: 30px;
                display: flex;
                align-items: center;
                justify-content: flex-start;
                color: white;
                font-size: 58px;
                font-weight: bold;
                box-shadow: 0px 0px 50px rgba(0, 0, 0, 0.4);
                padding: 20px;
                overflow: hidden;
            }

            .ens-text {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 100%;
                text-align: left;
                flex-shrink: 1;
                width: 100%;
            }

            /* Buyer/Seller Pills (Bottom) */
            .pills-section {
                position: absolute;
                bottom: 28px;
                left: 0;
                right: 0;
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 0 26px;
            }

            .pill {
                width: 433px;
                height: 132px;
                background: #242424;
                border-radius: 66px;
                display: flex;
                align-items: center;
                padding: 16px 20px;
                box-shadow: 0px 0px 50px rgba(0, 0, 0, 0.4);
            }

            .pill-left {
                justify-content: flex-start;
            }

            .pill-right {
                justify-content: flex-start;
            }

            .avatar {
                width: 100px;
                height: 100px;
                border-radius: 50px;
                object-fit: cover;
                margin: 0 16px 0 0;
            }

            .avatar-placeholder {
                width: 100px;
                height: 100px;
                border-radius: 50px;
                margin: 0 16px 0 0;
                background-color: #666;
                background-size: contain;
                background-position: center;
                background-repeat: no-repeat;
            }

            .pill-right .avatar,
            .pill-right .avatar-placeholder {
                margin: 0 16px 0 0;
            }

            .pill-text {
                color: white;
                font-size: 36px;
                font-weight: bold;
                flex: 1;
                text-align: left;
                word-break: break-word;
            }

            /* Arrow between pills */
            .arrow {
                color: white;
                font-size: 72px;
                font-weight: bold;
                text-shadow: 0px 0px 50px rgba(255, 255, 255, 0.25);
                line-height: 1;
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
        <div class="container">
            <!-- Price Section -->
            <div class="price-section">
                <div class="eth-price">${data.priceEth.toFixed(2)}</div>
                <div class="eth-label">ETH</div>
                <div class="usd-price">$${data.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
                <div class="usd-label">USD</div>
            </div>

            <!-- ENS Image Section -->
            <div class="ens-image-section">
                ${data.nftImageUrl ? 
                    `<img src="${data.nftImageUrl}" alt="NFT Image" class="ens-image" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                     <div class="ens-placeholder" style="display: none;"><span class="ens-text">${ensNameWithEmojis}</span></div>` :
                    `<div class="ens-placeholder"><span class="ens-text">${ensNameWithEmojis}</span></div>`
                }
            </div>

            <!-- Buyer/Seller Pills -->
            <div class="pills-section">
                <!-- Seller Pill (Left) -->
                <div class="pill pill-left">
                    ${data.sellerAvatar ? 
                        `<img src="${data.sellerAvatar}" alt="Seller Avatar" class="avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                         <div class="avatar-placeholder" style="display: none; ${userPlaceholderBase64 ? `background-image: url(${userPlaceholderBase64});` : ''}"></div>` :
                        `<div class="avatar-placeholder" style="${userPlaceholderBase64 ? `background-image: url(${userPlaceholderBase64});` : ''}"></div>`
                    }
                    <div class="pill-text">${sellerEnsWithEmojis}</div>
                </div>

                <!-- Arrow -->
                <div class="arrow">→</div>

                <!-- Buyer Pill (Right) -->
                <div class="pill pill-right">
                    ${data.buyerAvatar ? 
                        `<img src="${data.buyerAvatar}" alt="Buyer Avatar" class="avatar" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
                         <div class="avatar-placeholder" style="display: none; ${userPlaceholderBase64 ? `background-image: url(${userPlaceholderBase64});` : ''}"></div>` :
                        `<div class="avatar-placeholder" style="${userPlaceholderBase64 ? `background-image: url(${userPlaceholderBase64});` : ''}"></div>`
                    }
                    <div class="pill-text">${buyerEnsWithEmojis}</div>
                </div>
            </div>
        </div>
    </body>
    </html>`;
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
  public static getMockData(): MockImageData {
    return {
      priceEth: 5.51,
      priceUsd: 22560.01,
      ensName: 'name.eth', // Back to simple name for blue pill display
      nftImageUrl: undefined, // No NFT image URL for mock data, will use placeholder
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
