import { ProcessedSale } from '../types';
import { logger } from '../utils/logger';
import { EthIdentityService, EthIdentityAccount } from './ethIdentityService';
import { RealDataImageService, RealImageData } from './realDataImageService';
import { MockImageData } from '../types/imageTypes';
import { PuppeteerImageService } from './puppeteerImageService';
import { IDatabaseService } from '../types';

export interface GeneratedTweet {
  text: string;
  characterCount: number;
  isValid: boolean;
  imageBuffer?: Buffer; // Image buffer for Twitter upload
  imageUrl?: string; // Local URL for preview
  imageData?: RealImageData; // Image generation data
}

/**
 * New tweet formatter service that generates tweets in the enhanced format:
 * 
 * "hernandez.eth sold for 2.00 ETH ($8,000.00)
 * 
 * @maxidoteth sold to 0xabcdefg1
 * 
 * #ENS #ENSDomains #Ethereum"
 */
export class NewTweetFormatter {
  private readonly MAX_TWEET_LENGTH = 280;
  private readonly ethIdentityService = new EthIdentityService();

  constructor(private databaseService?: IDatabaseService) {}

  /**
   * Generate a complete tweet with text and image for a sale
   */
  async generateTweet(sale: ProcessedSale): Promise<GeneratedTweet> {
    try {
      logger.info(`Generating new format tweet for sale: ${sale.transactionHash}`);

      // Get full account data for buyer and seller to access Twitter records
      const [buyerAccount, sellerAccount] = await Promise.all([
        this.getAccountData(sale.buyerAddress),
        this.getAccountData(sale.sellerAddress)
      ]);

      // Generate the tweet text
      const tweetText = this.formatTweetText(sale, buyerAccount, sellerAccount);
      
      // Generate image if database service is available
      let imageBuffer: Buffer | undefined;
      let imageUrl: string | undefined;
      let imageData: RealImageData | undefined;

      if (this.databaseService) {
        try {
          logger.info(`Generating image for sale: ${sale.transactionHash}`);
          const realDataService = new RealDataImageService(this.databaseService, this.ethIdentityService);
          
          // Convert sale to image data
          const saleImageData = await realDataService.convertSaleToImageData(sale);
          
          // Convert RealImageData to MockImageData for image generation
          const mockImageData = this.convertRealToMockImageData(saleImageData, sale);
          
          // Generate image buffer using Puppeteer
          imageBuffer = await PuppeteerImageService.generateSaleImage(mockImageData);
          
          // Save image for preview
          const filename = `tweet-image-${sale.id}-${Date.now()}.png`;
          const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, this.databaseService);
          
          // Set image URL based on storage location
          if (savedPath.startsWith('/api/images/')) {
            imageUrl = savedPath; // Database storage (Vercel)
          } else {
            imageUrl = `/generated-images/${filename}`; // File storage (local)
          }
          imageData = saleImageData;
          
          logger.info(`Generated image for tweet: ${filename}`);
        } catch (imageError: any) {
          logger.error('Error generating image for tweet:', imageError.message);
          // Continue without image - tweet text is still valid
        }
      }
      
      const result: GeneratedTweet = {
        text: tweetText,
        characterCount: tweetText.length,
        isValid: tweetText.length <= this.MAX_TWEET_LENGTH && tweetText.length > 0,
        imageBuffer,
        imageUrl,
        imageData
      };

      logger.info(`Generated tweet: ${result.characterCount} chars, valid: ${result.isValid}, hasImage: ${!!result.imageBuffer}`);
      return result;

    } catch (error: any) {
      logger.error('Error generating tweet:', error.message);
      return {
        text: '',
        characterCount: 0,
        isValid: false
      };
    }
  }

  /**
   * Get full account data for an address
   */
  private async getAccountData(address: string): Promise<EthIdentityAccount | null> {
    try {
      const response = await fetch(`http://api.ethfollow.xyz/api/v1/users/${address}/account`);
      if (!response.ok) {
        return null;
      }
      return await response.json();
    } catch (error) {
      logger.warn(`Failed to get account data for ${address}:`, error);
      return null;
    }
  }

  /**
   * Format the tweet text according to the new specification
   */
  private formatTweetText(
    sale: ProcessedSale, 
    buyerAccount: EthIdentityAccount | null, 
    sellerAccount: EthIdentityAccount | null
  ): string {
    // Header: Emoji + SOLD
    const header = '💰 SOLD';
    
    // Line 1: ENS name
    const ensName = sale.nftName || 'Unknown ENS';
    
    // Line 2: Price in ETH and USD
    const priceEth = parseFloat(sale.priceEth).toFixed(2);
    const priceUsd = sale.priceUsd ? `($${parseFloat(sale.priceUsd).toLocaleString()})` : '';
    const priceLine = `Price: ${priceEth} ETH ${priceUsd}`.trim();
    
    // Line 3: Seller
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    const sellerLine = `Seller: ${sellerHandle}`;
    
    // Line 4: Buyer
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const buyerLine = `Buyer: ${buyerHandle}`;
    
    // Line 5: Vision.io marketplace link
    const visionUrl = this.buildVisionioUrl(ensName);
    
    // Combine all lines with double line breaks
    return `${header}\n\n${ensName}\n\n${priceLine}\n${sellerLine}\n${buyerLine}\n\n${visionUrl}`;
  }

  /**
   * Build Vision.io marketplace URL for an ENS name
   */
  private buildVisionioUrl(ensName: string): string {
    // Remove .eth suffix if present and clean the name
    const cleanName = ensName.replace(/\.eth$/i, '').trim();
    
    // Handle cases where ensName might be "Unknown ENS" or similar
    if (!cleanName || cleanName.toLowerCase().includes('unknown') || cleanName.toLowerCase().includes('ens')) {
      return 'https://vision.io/marketplace';
    }
    
    // Normalize emoji by removing variation selectors (U+FE0F) that Vision.io doesn't expect
    const normalizedName = cleanName.replace(/\uFE0F/g, '');
    
    // For tweet display, use the readable emoji URL (Twitter will handle the encoding when clicked)
    return `https://vision.io/name/ens/${normalizedName}.eth`;
  }

  /**
   * Clean and format a Twitter handle from ENS records
   * Handles various formats like:
   * - "twitter.com/james" → "james"
   * - "x.com/james" → "james"
   * - "https://twitter.com/james" → "james"
   * - "https://x.com/james" → "james"
   * - "@james" → "james"
   * - "james" → "james"
   */
  private cleanTwitterHandle(handle: string): string {
    if (!handle) return '';
    
    // Remove any URL parts (twitter.com/, x.com/, https://twitter.com/, https://x.com/, etc.)
    let cleaned = handle.replace(/^(?:https?:\/\/)?(?:www\.)?(?:(?:twitter|x)\.com\/)?/i, '');
    
    // Remove @ if it's at the beginning
    cleaned = cleaned.replace(/^@/, '');
    
    // Remove any trailing slashes or spaces
    cleaned = cleaned.trim().replace(/\/$/, '');
    
    return cleaned;
  }

  /**
   * Get the best display handle for an account
   * Shows both ENS name and Twitter handle when available:
   * - "ensname.eth @twitterhandle" (if both exist)
   * - "ensname.eth" (if only ENS exists)
   * - "@twitterhandle" (if only Twitter exists - shouldn't happen but handled)
   * - "0xabcd...efg1" (truncated address fallback)
   */
  private getDisplayHandle(account: EthIdentityAccount | null, fallbackAddress: string): string {
    if (!account) {
      return this.shortenAddress(fallbackAddress);
    }

    const ensName = account.ens?.name;
    const twitterRecord = account.ens?.records?.['com.twitter'];
    
    // Clean the Twitter handle if it exists
    const cleanedTwitter = twitterRecord ? this.cleanTwitterHandle(twitterRecord) : null;
    
    // Build the display string based on what's available
    if (ensName && cleanedTwitter) {
      // Both ENS and Twitter: show both
      return `${ensName} @${cleanedTwitter}`;
    } else if (ensName) {
      // Only ENS name
      return ensName;
    } else if (cleanedTwitter) {
      // Only Twitter (edge case, but handle it)
      return `@${cleanedTwitter}`;
    }

    // Fallback to shortened address
    return this.shortenAddress(account.address || fallbackAddress);
  }

  /**
   * Convert RealImageData to MockImageData for image generation
   */
  private convertRealToMockImageData(realData: RealImageData, sale: ProcessedSale): MockImageData {
    return {
      priceEth: realData.priceEth,
      priceUsd: realData.priceUsd,
      ensName: realData.ensName,
      nftImageUrl: realData.nftImageUrl,
      buyerAddress: sale.buyerAddress,
      buyerEns: realData.buyerEns,
      buyerAvatar: realData.buyerAvatar,
      sellerAddress: sale.sellerAddress,
      sellerEns: realData.sellerEns,
      sellerAvatar: realData.sellerAvatar,
      transactionHash: sale.transactionHash,
      timestamp: new Date() // Use current timestamp
    };
  }

  /**
   * Shorten Ethereum address for display
   */
  private shortenAddress(address: string): string {
    if (!address || address.length < 10) return address;
    return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
  }

  /**
   * Validate tweet content
   */
  validateTweet(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!content || content.trim().length === 0) {
      errors.push('Tweet content cannot be empty');
    }

    if (content.length > this.MAX_TWEET_LENGTH) {
      errors.push(`Tweet too long: ${content.length} characters (max ${this.MAX_TWEET_LENGTH})`);
    }

    // Check for required elements in new format
    if (!content.includes('💰 SOLD')) {
      errors.push('Tweet should include "💰 SOLD" header');
    }

    if (!content.includes('Price:')) {
      errors.push('Tweet should include "Price:" label');
    }

    if (!content.includes('ETH')) {
      errors.push('Tweet should include price in ETH');
    }

    if (!content.includes('Seller:')) {
      errors.push('Tweet should include "Seller:" label');
    }

    if (!content.includes('Buyer:')) {
      errors.push('Tweet should include "Buyer:" label');
    }

    if (!content.includes('vision.io')) {
      errors.push('Tweet should include Vision.io link');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Preview tweet format for a sale
   */
  async previewTweet(sale: ProcessedSale): Promise<{
    tweet: GeneratedTweet;
    validation: { valid: boolean; errors: string[] };
    breakdown: {
      header: string;
      ensName: string;
      priceLine: string;
      sellerLine: string;
      buyerLine: string;
      visionUrl: string;
      buyerHandle: string;
      sellerHandle: string;
    };
  }> {
    const tweet = await this.generateTweet(sale);
    const validation = this.validateTweet(tweet.text);
    
    // Get account data for breakdown
    const [buyerAccount, sellerAccount] = await Promise.all([
      this.getAccountData(sale.buyerAddress),
      this.getAccountData(sale.sellerAddress)
    ]);

    const ensName = sale.nftName || 'Unknown ENS';
    const priceEth = parseFloat(sale.priceEth).toFixed(2);
    const priceUsd = sale.priceUsd ? `($${parseFloat(sale.priceUsd).toLocaleString()})` : '';
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    
    const breakdown = {
      header: '💰 SOLD',
      ensName: ensName,
      priceLine: `Price: ${priceEth} ETH ${priceUsd}`.trim(),
      sellerLine: `Seller: ${sellerHandle}`,
      buyerLine: `Buyer: ${buyerHandle}`,
      visionUrl: this.buildVisionioUrl(ensName),
      buyerHandle: buyerHandle,
      sellerHandle: sellerHandle
    };

    return { tweet, validation, breakdown };
  }
}
