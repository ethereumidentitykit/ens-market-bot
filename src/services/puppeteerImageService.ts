import { logger } from '../utils/logger';
import { ImageData } from '../types/imageTypes';
import { IDatabaseService } from '../types';
import { emojiMappingService } from './emojiMappingService';
import { RealImageData } from './realDataImageService';
import { SvgConverter } from '../utils/svgConverter';
import { UnicodeEmojiService } from './unicodeEmojiService';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

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
   * Generate image with specified background type
   */
  private static async generateImageWithBackground(
    data: ImageData, 
    imageType: 'sale' | 'registration' | 'bid', 
    databaseService?: IDatabaseService
  ): Promise<Buffer> {
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
      const htmlContent = await this.generateHTML(data, imageType, databaseService);
      logger.debug(`Generated HTML content length: ${htmlContent.length} chars`);
      
      // Set the HTML content
      const contentStartTime = Date.now();
      await page.setContent(htmlContent, { 
        waitUntil: 'domcontentloaded',
        timeout: 30000 // Increased timeout to 30s but using faster wait condition
      });
      logger.debug(`Page content loaded in ${Date.now() - contentStartTime}ms`);

      // Small delay to ensure fonts and rendering are complete
      await new Promise(resolve => setTimeout(resolve, 1500));
      logger.debug('Fonts and rendering delay complete, proceeding with image generation');

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
   * Load NFT image with fallback chain: original URL → ENS metadata service → placeholder
   */
  private static async loadNftImageWithFallbacks(
    originalUrl: string, 
    ensName: string, 
    placeholderBase64: string
  ): Promise<string> {
    // Try original URL first with short timeout
    logger.debug(`Attempting to load NFT image: ${originalUrl.substring(0, 100)}...`);
    
    const originalImageBase64 = await this.loadRemoteImageAsBase64(originalUrl, 5000); // 5s timeout
    if (originalImageBase64) {
      logger.debug(`Successfully loaded original NFT image`);
      return originalImageBase64;
    }
    
    // Try ENS metadata service as fallback
    const ensMetadataUrl = `https://metadata.ens.domains/mainnet/avatar/${ensName}`;
    logger.debug(`Original NFT image failed, trying ENS metadata service: ${ensMetadataUrl}`);
    
    const ensImageBase64 = await this.loadRemoteImageAsBase64(ensMetadataUrl, 5000); // 5s timeout
    if (ensImageBase64) {
      logger.debug(`Successfully loaded ENS metadata image as fallback`);
      return ensImageBase64;
    }
    
    // Final fallback to placeholder
    logger.warn(`Both NFT image sources failed, using placeholder for: ${ensName}`);
    return `data:image/png;base64,${placeholderBase64}`;
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
    
    // Convert NFT SVG to PNG (all NFT images are SVG format)
    let nftImageBase64 = `data:image/png;base64,${ensPlaceholderBase64}`; // Default fallback
    if (data.nftImageUrl) {
      try {
        logger.info(`🖼️ Processing NFT image: ${data.nftImageUrl}`);
        
        // Download the SVG content
        const svgResponse = await axios.get(data.nftImageUrl, {
          timeout: 10000,
          headers: { 'User-Agent': 'ENS-TwitterBot/1.0' }
        });
        
        const svgContent = svgResponse.data;
        logger.info(`📥 Downloaded NFT SVG (${svgContent.length} chars): ${svgContent.substring(0, 150)}...`);
        
        // Parse SVG to extract background and text, rebuild as HTML
        const htmlContent = await this.convertSvgToHtmlWithEmojis(svgContent);
        logger.info(`🔄 Converted SVG to HTML overlay with emoji processing`);
        
        // Convert HTML to PNG using SvgConverter
        const pngBuffer = await SvgConverter.convertSvgToPng(htmlContent);
        const pngBase64 = pngBuffer.toString('base64');
        
        nftImageBase64 = `data:image/png;base64,${pngBase64}`;
        logger.info(`✅ Successfully converted NFT to PNG with Apple emojis`);
      } catch (error: any) {
        logger.warn(`❌ Failed to process NFT SVG image: ${data.nftImageUrl}`, error.message);
        // Falls back to placeholder
      }
    } else {
      logger.info(`ℹ️  No NFT image URL provided, using placeholder`);
    }
    
    // Convert avatar URLs to base64 data URLs (SEQUENTIAL to prevent resource exhaustion)
    let sellerAvatarPath = `data:image/png;base64,${userPlaceholderBase64}`;
    if (data.sellerAvatar) {
      logger.debug(`Processing seller avatar: ${data.sellerAvatar.substring(0, 100)}...`);
      const sellerAvatarBase64 = await this.loadRemoteImageAsBase64(data.sellerAvatar);
      if (sellerAvatarBase64) {
        sellerAvatarPath = sellerAvatarBase64;
        logger.debug(`Loaded seller avatar successfully: ${data.sellerAvatar}`);
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
    let sellerEnsWithEmojis = data.sellerEns || 'seller';
    let buyerEnsWithEmojis = data.buyerEns || 'buyer';
    
    logger.info(`🏷️ Processing emojis in names:`);
    logger.info(`  📛 ENS: "${data.ensName}"`);
    logger.info(`  👤 Seller: "${data.sellerEns || 'seller'}"`);  
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
      sellerEnsWithEmojis = await emojiMappingService.replaceEmojisWithSvg(data.sellerEns || 'seller');
      logger.info(`✅ Seller emoji processing: "${data.sellerEns}" -> ${sellerEnsWithEmojis.length} chars`);
      if (sellerEnsWithEmojis !== (data.sellerEns || 'seller')) {
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
                background-image: url("${nftImageBase64}");
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

            <!-- ENS NFT Image (Converted PNG) -->
            <img src="${nftImageBase64}" alt="ENS NFT" class="ens-nft" 
                 onload="console.log('NFT image loaded successfully');"
            >

            <!-- USD Price -->
            <div class="usd-price">
                ${formattedUsdPrice}
            </div>

            <!-- ETH Price -->
            <div class="eth-price">
                ${this.formatEthPrice(data.priceEth)} ETH
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
   * Replace Unicode emojis in SVG content with Apple emoji SVGs
   */
  private static async replaceEmojisInSvg(svgContent: string): Promise<string> {
    let result = svgContent;
    
    logger.info(`🔍 Starting emoji replacement in NFT SVG content (${svgContent.length} chars):`);
    logger.info(`📄 SVG content preview: ${svgContent.substring(0, 200)}...`);
    
    // Use sophisticated Unicode emoji detection (handles ZWJ sequences properly)
    const emojis = UnicodeEmojiService.detectEmojis(result);
    
    logger.info(`🎯 UnicodeEmojiService detected ${emojis.length} emojis in NFT SVG:`);
    emojis.forEach((emojiInfo, index) => {
      const codePoints = emojiInfo.emoji.split('').map(c => 
        '\\u{' + c.codePointAt(0)!.toString(16).toUpperCase() + '}'
      ).join('');
      logger.info(`  ${index + 1}. "${emojiInfo.emoji}" at position ${emojiInfo.position} (${codePoints}) - ${emojiInfo.description}`);
    });
    
    if (emojis.length === 0) {
      logger.info(`⚠️  No emojis detected in NFT SVG content`);
      return result;
    }
    
    // Process emojis in reverse order (by position) to avoid index shifting
    const sortedEmojis = emojis.sort((a, b) => b.position - a.position);
    
    let replacementCount = 0;
    for (const emojiInfo of sortedEmojis) {
      logger.info(`🔄 Processing NFT SVG emoji "${emojiInfo.emoji}" at position ${emojiInfo.position}...`);
      
      const appleSvgContent = await emojiMappingService.getEmojiSvg(emojiInfo.emoji);
      if (appleSvgContent) {
        // Calculate end position
        const endPosition = emojiInfo.position + emojiInfo.emoji.length;
        
        // Log the replacement context
        const beforeContext = result.substring(Math.max(0, emojiInfo.position - 10), emojiInfo.position);
        const afterContext = result.substring(endPosition, Math.min(result.length, endPosition + 10));
        logger.info(`🔀 Replacing "${emojiInfo.emoji}" in context: "${beforeContext}[${emojiInfo.emoji}]${afterContext}"`);
        
        // Extract just the SVG path/shape content from the Apple emoji (remove <svg> wrapper)
        let emojiSvgContent = appleSvgContent;
        
        // Remove the outer <svg> wrapper and extract inner content
        const svgMatch = emojiSvgContent.match(/<svg[^>]*>(.*?)<\/svg>/s);
        if (svgMatch) {
          const innerContent = svgMatch[1];
          // Create a tspan with inline SVG for text compatibility  
          emojiSvgContent = `<tspan><svg viewBox="0 0 64 64" width="1em" height="1em" style="display: inline-block; vertical-align: -0.125em;">${innerContent}</svg></tspan>`;
        } else {
          // Fallback: use the emoji as-is (Unicode)
          logger.warn(`⚠️ Could not extract SVG content from Apple emoji, keeping Unicode: "${emojiInfo.emoji}"`);
          continue;
        }
        
        // Replace the emoji
        result = result.substring(0, emojiInfo.position) + emojiSvgContent + result.substring(endPosition);
        replacementCount++;
        
        logger.info(`✅ Successfully replaced NFT SVG emoji "${emojiInfo.emoji}" (${emojiInfo.description}) with inline Apple SVG`);
      } else {
        logger.warn(`❌ No Apple SVG found for NFT emoji "${emojiInfo.emoji}" (${emojiInfo.description})`);
        logger.info(`🔍 Checking if emojiMappingService supports this emoji...`);
        const isSupported = await emojiMappingService.isEmojiSupported(emojiInfo.emoji);
        logger.info(`📋 emojiMappingService.isEmojiSupported("${emojiInfo.emoji}"): ${isSupported}`);
      }
    }
    
    logger.info(`🎉 NFT SVG emoji replacement complete: ${replacementCount}/${emojis.length} emojis replaced`);
    if (replacementCount > 0) {
      logger.info(`📄 Final NFT SVG content preview: ${result.substring(0, 200)}...`);
    }
    
    return result;
  }

  /**
   * Get mock data for testing
   */
  public static getMockData(): ImageData {
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

  /**
   * Convert ENS SVG to HTML with proper emoji processing
   * Extracts background image and text, rebuilds as HTML where emojiMappingService works
   */
  private static async convertSvgToHtmlWithEmojis(svgContent: string): Promise<string> {
    logger.info(`🔍 Parsing SVG structure for HTML conversion`);
    
    // Extract background - could be a custom image OR use default ENS background
    let backgroundStyle = '';
    
    // Check for image background (custom ENS avatar)
    const imageMatch = svgContent.match(/<image[^>]*href="([^"]+)"/);
    if (imageMatch) {
      const backgroundImage = imageMatch[1];
      backgroundStyle = `background: url('${backgroundImage}') no-repeat center/cover;`;
      logger.info(`📷 Found custom background image`);
    } else {
      // Use default ENS gradient background image
      const defaultBgPath = path.join(__dirname, '../../assets/ens-default-background.png');
      const defaultBgBase64 = fs.readFileSync(defaultBgPath, 'base64');
      backgroundStyle = `background: url('data:image/png;base64,${defaultBgBase64}') no-repeat center/cover;`;
      logger.info(`🎨 Using default ENS background image`);
    }
    
    // Extract all <path> elements (ENS logo)
    const pathMatches = Array.from(svgContent.matchAll(/<path[^>]*d="([^"]+)"[^>]*fill="([^"]*)"[^>]*\/>/g));
    logger.info(`🎨 Found ${pathMatches.length} path elements (ENS logo)`);
    
    // Build SVG for paths (ENS logo)
    let svgPaths = '';
    if (pathMatches.length > 0) {
      const pathElements = pathMatches.map(match => 
        `<path d="${match[1]}" fill="${match[2] || 'white'}" />`
      ).join('\n');
      
      svgPaths = `
        <svg style="position: absolute; top: 0; left: 0; width: 270px; height: 270px;" 
             viewBox="0 0 270 270" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <filter id="dropShadow" color-interpolation-filters="sRGB">
              <feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.225"/>
            </filter>
          </defs>
          <g filter="url(#dropShadow)">
            ${pathElements}
          </g>
        </svg>
      `;
    }
    
    // Extract text elements with ALL attributes
    const textRegex = /<text[^>]*>([^<]+)<\/text>/g;
    const textAttrRegex = /(\w+)="([^"]+)"/g;
    let textMatch;
    let htmlTextElements = [];
    
    while ((textMatch = textRegex.exec(svgContent)) !== null) {
      const fullTextElement = textMatch[0];
      const textContent = textMatch[1];
      
      // Extract all attributes
      let attrs: any = {};
      let attrMatch;
      while ((attrMatch = textAttrRegex.exec(fullTextElement)) !== null) {
        attrs[attrMatch[1]] = attrMatch[2];
      }
      
      const x = attrs.x || '0';
      const y = attrs.y || '0';
      const fontSize = attrs['font-size'] || attrs.fontSize || '32px';
      const fill = attrs.fill || 'white';
      
      logger.info(`  📍 Text at (${x}, ${y}): "${textContent}" [size: ${fontSize}]`);
      
      // Process emojis using our mapping service
      const processedText = await emojiMappingService.replaceEmojisWithSvg(textContent);
      logger.info(`  ✅ Processed: ${processedText.length > 100 ? processedText.substring(0, 100) + '...' : processedText}`);
      
      // Create positioned div with correct font properties
      // Adjust inline SVG emoji styling for proper baseline alignment
      const alignedText = processedText.replace(/style="[^"]*"/g, 
        'style="display: inline-block; vertical-align: text-bottom; width: 1em; height: 1em; margin: 0 0.05em;"'
      );
      
      htmlTextElements.push(`
        <div style="position: absolute; left: ${x}px; top: ${y}px; 
                    font-family: Satoshi, system-ui, sans-serif;
                    font-size: ${fontSize}; font-weight: 700; color: ${fill};
                    line-height: 1; 
                    filter: drop-shadow(0px 1px 2px rgba(0,0,0,0.225));">
          ${alignedText}
        </div>
      `);
    }
    
    // Build complete HTML with background, logo, and text
    const html = `
      <div style="width: 270px; height: 270px; position: relative; overflow: hidden; ${backgroundStyle}">
        ${svgPaths}
        ${htmlTextElements.join('')}
      </div>
    `;
    
    logger.info(`✨ Built HTML overlay with ${pathMatches.length} paths and ${htmlTextElements.length} text elements`);
    return html;
  }
}
