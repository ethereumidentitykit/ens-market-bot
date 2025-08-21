import { logger } from '../utils/logger';
import { MockImageData } from '../types/imageTypes';
import { IDatabaseService } from '../types';
import { emojiMappingService } from './emojiMappingService';
import { RealImageData } from './realDataImageService';
import * as fs from 'fs';
import * as path from 'path';

export class PuppeteerImageService {
  private static readonly IMAGE_WIDTH = 1000;
  private static readonly IMAGE_HEIGHT = 545;

  /**
   * Generate ENS registration image using Puppeteer
   */
  public static async generateRegistrationImage(data: RealImageData): Promise<Buffer> {
    // Convert RealImageData to MockImageData format for compatibility
    const mockData: MockImageData = {
      priceEth: data.priceEth,
      priceUsd: data.priceUsd,
      ensName: data.ensName,
      nftImageUrl: data.nftImageUrl,
      buyerAddress: '0x0000000000000000000000000000000000000000', // Placeholder
      buyerEns: data.buyerEns, // New owner
      buyerAvatar: data.buyerAvatar,
      sellerAddress: '0x0000000000000000000000000000000000000000', // Placeholder
      sellerEns: data.sellerEns, // "ENS DAO"
      sellerAvatar: this.getDaoProfileBase64(), // Use DAO avatar for registrations
      transactionHash: data.transactionHash || '0x0000',
      timestamp: new Date()
    };

    return await this.generateImageWithBackground(mockData, 'registration');
  }

  /**
   * Generate ENS sale image using Puppeteer
   */
  public static async generateSaleImage(data: MockImageData): Promise<Buffer> {
    return await this.generateImageWithBackground(data, 'sale');
  }

  /**
   * Generate image with specified background type
   */
  private static async generateImageWithBackground(data: MockImageData, imageType: 'sale' | 'registration'): Promise<Buffer> {
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

      // Generate HTML content with emoji replacement and background type
      const htmlContent = await this.generateHTML(data, imageType);
      
      // Set the HTML content
      await page.setContent(htmlContent, { 
        waitUntil: 'networkidle0',
        timeout: 15000 
      });

      // Wait for fonts to load
      await page.evaluateOnNewDocument(() => {
        document.fonts.ready;
      });
      
      // Small delay to ensure fonts are rendered
      await new Promise(resolve => setTimeout(resolve, 1000));

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
   * Load image file as base64 string
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
   * Generate HTML template with embedded CSS - NEW EXACT POSITIONING
   */
  private static async generateHTML(data: MockImageData, imageType: 'sale' | 'registration' | 'bid' = 'sale'): Promise<string> {
    // Load actual template images as base64
    const backgroundImageBase64 = this.loadAsBase64('assets/image-templates/sales/sale-t1.png');
    const userPlaceholderBase64 = this.loadAsBase64('assets/image-templates/user.png');
    const ensPlaceholderBase64 = this.loadAsBase64('assets/image-templates/ens.png');
    
    // Use actual images or fallbacks
    const templateImagePath = `data:image/png;base64,${backgroundImageBase64}`;
    const ensNftImagePath = data.nftImageUrl || `data:image/png;base64,${ensPlaceholderBase64}`;
    const sellerAvatarPath = data.sellerAvatar || `data:image/png;base64,${userPlaceholderBase64}`;
    const buyerAvatarPath = data.buyerAvatar || `data:image/png;base64,${userPlaceholderBase64}`;
    
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
        <title>ENS Transaction Image</title>
        <link rel="preconnect" href="https://fonts.googleapis.com">
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
        <style>
            * {
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }
            
            body {
                width: ${this.IMAGE_WIDTH}px;
                height: ${this.IMAGE_HEIGHT}px;
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
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

            /* ENS NFT Image (Right Side) */
            .ens-nft {
                position: absolute;
                left: 500px;
                top: 45px;
                width: 455px;
                height: 455px;
                border-radius: 19px;
                object-fit: cover;
                background-image: url("${ensNftImagePath}");
                background-size: cover;
                background-position: center;
                background-repeat: no-repeat;
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
            }

            /* Seller Section (Dynamic Positioning) */
            .seller-section {
                position: absolute;
                right: 545px;
                top: 390px;
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
            }

            .seller-avatar {
                width: 50px;
                height: 50px;
                border-radius: 50%;
                object-fit: cover;
                background-image: url("${sellerAvatarPath}");
                background-size: cover;
                background-position: center;
                background-repeat: no-repeat;
                border: 2px solid rgba(255, 255, 255, 0.3);
            }

            /* Buyer Section (Dynamic Positioning) */
            .buyer-section {
                position: absolute;
                right: 545px;
                top: 477px;
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
            }

            .buyer-avatar {
                width: 50px;
                height: 50px;
                border-radius: 50%;
                object-fit: cover;
                background-image: url("${buyerAvatarPath}");
                background-size: cover;
                background-position: center;
                background-repeat: no-repeat;
                border: 2px solid rgba(255, 255, 255, 0.3);
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

            <!-- ENS NFT Image -->
            <img src="${ensNftImagePath}" alt="ENS NFT" class="ens-nft" onerror="this.src='data:image/png;base64,${ensPlaceholderBase64}'">

            <!-- USD Price -->
            <div class="usd-price">
                ${data.priceUsd}
            </div>

            <!-- ETH Price -->
            <div class="eth-price">
                ${data.priceEth} ETH
            </div>

            <!-- Seller Section -->
            <div class="seller-section">
                <div class="seller-name">${data.sellerEns || 'seller'}</div>
                <img src="${sellerAvatarPath}" alt="Seller" class="seller-avatar" onerror="this.src='data:image/png;base64,${userPlaceholderBase64}'">
            </div>

            <!-- Buyer Section -->
            <div class="buyer-section">
                <div class="buyer-name">${data.buyerEns || 'buyer'}</div>
                <img src="${buyerAvatarPath}" alt="Buyer" class="buyer-avatar" onerror="this.src='data:image/png;base64,${userPlaceholderBase64}'">
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
