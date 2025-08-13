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
    // Line 1: ENS name + sale price (ETH + USD)
    const ensName = sale.nftName || 'Unknown ENS';
    const priceEth = parseFloat(sale.priceEth).toFixed(2);
    const priceUsd = sale.priceUsd ? `($${parseFloat(sale.priceUsd).toLocaleString()})` : '';
    const line1 = `${ensName} sold for ${priceEth} ETH ${priceUsd}`.trim();

    // Line 2: Seller handle + "sold to" + buyer handle
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const line2 = `${sellerHandle} -> ${buyerHandle}`;

    // Line 3: Standard hashtags
    const line3 = '#ENS #ENSDomains #Ethereum';

    // Combine with double line breaks
    return `${line1}\n\n${line2}\n\n${line3}`;
  }

  /**
   * Get the best display handle for an account based on priority:
   * 1. @twitterhandle (if com.twitter record exists)
   * 2. ensname.eth (if ENS exists but no Twitter)
   * 3. 0xabcd...efg1 (truncated address fallback)
   */
  private getDisplayHandle(account: EthIdentityAccount | null, fallbackAddress: string): string {
    if (!account) {
      return this.shortenAddress(fallbackAddress);
    }

    // Check for Twitter handle first
    const twitterHandle = account.ens?.records?.['com.twitter'];
    if (twitterHandle) {
      return `@${twitterHandle}`;
    }

    // Check for ENS name
    const ensName = account.ens?.name;
    if (ensName) {
      return ensName;
    }

    // Fallback to shortened address
    return this.shortenAddress(account.address);
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

    // Check for required elements
    if (!content.includes('ETH')) {
      errors.push('Tweet should include price in ETH');
    }

    if (!content.includes('#ENS')) {
      errors.push('Tweet should include #ENS hashtag');
    }

    if (!content.includes('sold')) {
      errors.push('Tweet should include "sold" text');
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
      line1: string;
      line2: string;
      line3: string;
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
    
    const breakdown = {
      line1: `${ensName} sold for ${priceEth} ETH ${priceUsd}`.trim(),
      line2: `${this.getDisplayHandle(sellerAccount, sale.sellerAddress)} sold to ${this.getDisplayHandle(buyerAccount, sale.buyerAddress)}`,
      line3: '#ENS #ENSDomains #Ethereum',
      buyerHandle: this.getDisplayHandle(buyerAccount, sale.buyerAddress),
      sellerHandle: this.getDisplayHandle(sellerAccount, sale.sellerAddress)
    };

    return { tweet, validation, breakdown };
  }
}
