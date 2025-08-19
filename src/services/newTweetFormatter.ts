import { ProcessedSale, ENSRegistration, ENSBid } from '../types';
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
   * Generate a complete tweet with text and image for an ENS registration
   */
  async generateRegistrationTweet(registration: ENSRegistration): Promise<GeneratedTweet> {
    try {
      logger.info(`Generating registration tweet for: ${registration.transactionHash}`);

      // Get account data for the new owner
      const ownerAccount = await this.getAccountData(registration.ownerAddress);

      // Generate the tweet text
      const tweetText = this.formatRegistrationTweetText(registration, ownerAccount);
      
      // Generate image if database service is available
      let imageBuffer: Buffer | undefined;
      let imageUrl: string | undefined;
      let imageData: RealImageData | undefined;

      if (this.databaseService) {
        try {
          logger.info(`Generating registration image for: ${registration.transactionHash}`);
          
          // Convert registration to image data format
          const registrationImageData = await this.convertRegistrationToImageData(registration, ownerAccount);
          
          // Generate image buffer using Puppeteer (registration-specific)
          imageBuffer = await PuppeteerImageService.generateRegistrationImage(registrationImageData);
          
          if (imageBuffer) {
            // Save image for preview
            const filename = `registration-tweet-image-${registration.id}-${Date.now()}.png`;
            const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, this.databaseService);
            
            // Set image URL based on storage location
            if (savedPath.startsWith('/api/images/')) {
              imageUrl = savedPath; // Database storage (Vercel)
            } else {
              imageUrl = `/generated-images/${filename}`; // File storage (local)
            }
            imageData = registrationImageData;
            
            logger.info(`Generated registration image: ${filename}`);
          }
        } catch (imageError: any) {
          logger.error('Error generating image for registration tweet:', imageError.message);
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

      logger.info(`Generated registration tweet: ${result.characterCount} chars, valid: ${result.isValid}, hasImage: ${!!result.imageBuffer}`);
      return result;

    } catch (error: any) {
      logger.error('Error generating registration tweet:', error.message);
      return {
        text: '',
        characterCount: 0,
        isValid: false
      };
    }
  }

  /**
   * Generate a complete tweet with text and image for an ENS bid
   */
  async generateBidTweet(bid: ENSBid): Promise<GeneratedTweet> {
    try {
      logger.info(`Generating bid tweet for: ${bid.bidId}`);

      // Get account data for the bidder
      const bidderAccount = await this.getAccountData(bid.makerAddress);

      // Generate the tweet text
      const tweetText = await this.formatBidTweetText(bid, bidderAccount);
      
      // Generate image if database service is available
      let imageBuffer: Buffer | undefined;
      let imageUrl: string | undefined;
      let imageData: RealImageData | undefined;

      if (this.databaseService) {
        try {
          logger.info(`Generating bid image for: ${bid.bidId}`);
          
          // Convert bid to image data format
          const bidImageData = await this.convertBidToImageData(bid, bidderAccount);
          
          // Generate image buffer using Puppeteer (bid-specific - reuse registration background for now)
          imageBuffer = await PuppeteerImageService.generateRegistrationImage(bidImageData);
          
          imageData = bidImageData;
          
          logger.info(`✅ Generated bid image (${imageBuffer.length} bytes)`);
        } catch (imageError: any) {
          logger.warn(`Failed to generate bid image: ${imageError.message}`);
          // Continue without image - text-only tweet
        }
      }

      const result: GeneratedTweet = {
        text: tweetText,
        characterCount: tweetText.length,
        isValid: this.validateBidTweet(tweetText).valid,
        imageBuffer,
        imageUrl,
        imageData
      };

      logger.info(`✅ Generated bid tweet: ${result.characterCount} chars, valid: ${result.isValid}`);
      return result;

    } catch (error: any) {
      logger.error(`Failed to generate bid tweet: ${error.message}`);
      throw error;
    }
  }

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
   * Format the tweet text for ENS registrations
   */
  private formatRegistrationTweetText(
    registration: ENSRegistration, 
    ownerAccount: EthIdentityAccount | null
  ): string {
    // Header: Emoji + Registered
    const header = '🏛️ Registered';
    
    // Line 1: ENS name (use fullName if available, otherwise ensName)
    const ensName = registration.fullName || registration.ensName || 'Unknown ENS';
    
    // Line 2: Price in ETH and USD
    const priceEth = parseFloat(registration.costEth || '0').toFixed(2);
    const priceUsd = registration.costUsd ? `($${parseFloat(registration.costUsd).toLocaleString()})` : '';
    const priceLine = `Price: ${priceEth} ETH ${priceUsd}`.trim();
    
    // Line 3: New Owner
    const ownerHandle = this.getDisplayHandle(ownerAccount, registration.ownerAddress);
    const ownerLine = `New Owner: ${ownerHandle}`;
    
    // Line 4: Vision.io marketplace link
    const visionUrl = this.buildVisionioUrl(ensName);
    
    // Combine all lines with double line breaks (except between price and owner)
    return `${header}\n\n${ensName}\n\n${priceLine}\n${ownerLine}\n\n${visionUrl}`;
  }

  /**
   * Format bid tweet text according to the bid specification
   */
  private async formatBidTweetText(
    bid: ENSBid, 
    bidderAccount: EthIdentityAccount | null
  ): Promise<string> {
    // Header: ✋ Offer
    const header = '✋ Offer';
    
    // Line 1: ENS name - need to resolve from token ID
    const ensName = await this.resolveENSNameFromBid(bid);
    
    // Line 2: Price with currency display
    const currencyDisplay = this.getCurrencyDisplayName(bid.currencySymbol);
    const priceDecimal = parseFloat(bid.priceDecimal).toFixed(2);
    const priceUsd = bid.priceUsd ? `($${parseFloat(bid.priceUsd).toLocaleString()})` : '';
    const priceLine = `Price: ${priceDecimal} ${currencyDisplay} ${priceUsd}`.trim();
    
    // Line 3: From (bidder)
    const bidderHandle = this.getDisplayHandle(bidderAccount, bid.makerAddress);
    const fromLine = `From: ${bidderHandle}`;
    
    // Line 4: Marketplace
    const marketplaceLine = `Marketplace: ${bid.sourceName || 'Unknown'}`;
    
    // Line 5: Valid duration - dynamic calculation
    const duration = this.calculateBidDuration(bid.validFrom, bid.validUntil);
    const validLine = `Valid: ${duration}`;
    
    // Line 6: Vision.io marketplace link
    const visionUrl = this.buildVisionioUrl(ensName);
    
    // Combine all lines
    return `${header}\n\n${ensName}\n\n${priceLine}\n${fromLine}\n\n${marketplaceLine}\n${validLine}\n\n${visionUrl}`;
  }

  /**
   * Resolve ENS name from bid data using ENS metadata API
   * Makes live API call to get the actual ENS name
   */
  private async resolveENSNameFromBid(bid: ENSBid): Promise<string> {
    try {
      if (!bid.tokenId) {
        return 'unknown.eth';
      }

      logger.debug(`🔍 Resolving ENS name for token ID: ${bid.tokenId}`);
      
      // Use ENS Base Registrar contract for metadata
      const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
      const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
      
      const response = await fetch(metadataUrl);
      if (!response.ok) {
        throw new Error(`ENS API returned ${response.status}: ${response.statusText}`);
      }

      const metadata = await response.json();
      
      if (metadata && metadata.name) {
        const ensName = metadata.name;
        logger.debug(`✅ Resolved ENS name: ${ensName} for token ID: ${bid.tokenId}`);
        return ensName;
      } else {
        logger.warn(`⚠️  ENS metadata found but no name field for token ID: ${bid.tokenId}`);
        return `tokenid-${bid.tokenId.slice(-6)}.eth`; // Fallback format
      }

    } catch (error: any) {
      logger.warn(`Failed to resolve ENS name for token ID ${bid.tokenId}:`, error.message);
      return `tokenid-${bid.tokenId?.slice(-6) || 'unknown'}.eth`; // Fallback format
    }
  }

  /**
   * Get user-friendly currency display name
   */
  private getCurrencyDisplayName(symbol: string): string {
    const currencyMap: { [key: string]: string } = {
      'WETH': 'ETH',
      'USDC': 'USDC',
      'USDT': 'USDT', 
      'DAI': 'DAI'
    };
    return currencyMap[symbol.toUpperCase()] || symbol;
  }

  /**
   * Calculate human-readable duration from timestamps
   */
  private calculateBidDuration(validFrom: number, validUntil: number): string {
    const durationMs = (validUntil - validFrom) * 1000;
    const hours = Math.floor(durationMs / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    const months = Math.floor(days / 30);
    
    if (months >= 6) return `${months} months`;
    if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
    if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours >= 1) return `${hours}h`;
    return '< 1h';
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
   * Convert ENS registration to image data format for image generation
   */
  private async convertRegistrationToImageData(registration: ENSRegistration, ownerAccount: EthIdentityAccount | null): Promise<RealImageData> {
    logger.info(`Converting registration to image data: ${registration.transactionHash}`);
    
    // Parse prices
    const priceEth = parseFloat(registration.costEth || '0');
    const priceUsd = registration.costUsd ? parseFloat(registration.costUsd) : 0;
    
    // Get ENS name for display
    const ensName = registration.fullName || registration.ensName || 'Unknown ENS';
    
    // Get owner display info
    const ownerHandle = this.getDisplayHandle(ownerAccount, registration.ownerAddress);
    const ownerAvatar = ownerAccount?.ens?.records?.avatar;
    
    const imageData: RealImageData = {
      priceEth,
      priceUsd,
      ensName,
      buyerEns: ownerHandle, // New owner is the "buyer"
      sellerEns: 'ENS DAO', // ENS DAO is the "seller"
      buyerAvatar: ownerAvatar,
      sellerAvatar: undefined, // Will be handled by PuppeteerImageService with dao-profile.png
      nftImageUrl: registration.image, // Use ENS NFT image if available
      saleId: registration.id,
      transactionHash: registration.transactionHash
    };

    logger.info('Converted registration to image data:', {
      ensName: imageData.ensName,
      ownerEns: imageData.buyerEns,
      priceEth: imageData.priceEth,
      priceUsd: imageData.priceUsd,
      hasNftImage: !!imageData.nftImageUrl,
      hasOwnerAvatar: !!imageData.buyerAvatar
    });

    return imageData;
  }

  /**
   * Convert bid data to the structured format needed by image generation
   */
  private async convertBidToImageData(bid: ENSBid, bidderAccount: EthIdentityAccount | null): Promise<RealImageData> {
    logger.info(`Converting bid to image data: ${bid.bidId}`);
    
    // Parse prices
    const priceEth = parseFloat(bid.priceDecimal);
    const priceUsd = bid.priceUsd ? parseFloat(bid.priceUsd) : 0;
    
    // Get ENS name for display (live API call)
    const ensName = await this.resolveENSNameFromBid(bid);
    
    // Get bidder display info
    const bidderHandle = this.getDisplayHandle(bidderAccount, bid.makerAddress);
    const bidderAvatar = bidderAccount?.ens?.records?.avatar;
    
    const imageData: RealImageData = {
      priceEth,
      priceUsd,
      ensName,
      buyerEns: bidderHandle, // Bidder is the potential "buyer"
      sellerEns: 'Current Owner', // Placeholder for current owner
      buyerAvatar: bidderAvatar,
      sellerAvatar: undefined, // We don't know current owner yet
      nftImageUrl: bid.nftImage, // Use ENS NFT image if available
      saleId: bid.id,
      transactionHash: bid.bidId // Use bid ID as transaction reference
    };

    logger.info('Converted bid to image data:', {
      ensName: imageData.ensName,
      bidderEns: imageData.buyerEns,
      priceEth: imageData.priceEth,
      priceUsd: imageData.priceUsd,
      hasNftImage: !!imageData.nftImageUrl,
      hasBidderAvatar: !!imageData.buyerAvatar
    });

    return imageData;
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
   * Validate registration tweet content
   */
  validateRegistrationTweet(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!content || content.trim().length === 0) {
      errors.push('Registration tweet content cannot be empty');
    }

    if (content.length > this.MAX_TWEET_LENGTH) {
      errors.push(`Registration tweet too long: ${content.length} characters (max ${this.MAX_TWEET_LENGTH})`);
    }

    // Check for required elements in registration format
    if (!content.includes('🏛️ Registered')) {
      errors.push('Registration tweet should include "🏛️ Registered" header');
    }

    if (!content.includes('Price:')) {
      errors.push('Registration tweet should include "Price:" label');
    }

    if (!content.includes('ETH')) {
      errors.push('Registration tweet should include price in ETH');
    }

    if (!content.includes('New Owner:')) {
      errors.push('Registration tweet should include "New Owner:" label');
    }

    if (!content.includes('vision.io')) {
      errors.push('Registration tweet should include Vision.io link');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate bid tweet content 
   */
  validateBidTweet(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!content || content.trim().length === 0) {
      errors.push('Bid tweet content cannot be empty');
    }

    if (content.length > this.MAX_TWEET_LENGTH) {
      errors.push(`Bid tweet too long: ${content.length} characters (max ${this.MAX_TWEET_LENGTH})`);
    }

    // Check for required elements in bid format
    if (!content.includes('✋ Offer')) {
      errors.push('Bid tweet should include "✋ Offer" header');
    }

    if (!content.includes('Price:')) {
      errors.push('Bid tweet should include "Price:" label');
    }

    if (!content.includes('From:')) {
      errors.push('Bid tweet should include "From:" label');
    }

    if (!content.includes('Marketplace:')) {
      errors.push('Bid tweet should include "Marketplace:" label');
    }

    if (!content.includes('Valid:')) {
      errors.push('Bid tweet should include "Valid:" label');
    }

    if (!content.includes('vision.io')) {
      errors.push('Bid tweet should include Vision.io link');
    }

    return {
      valid: errors.length === 0,
      errors
    };
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

  /**
   * Preview registration tweet format
   */
  async previewRegistrationTweet(registration: ENSRegistration): Promise<{
    tweet: GeneratedTweet;
    validation: { valid: boolean; errors: string[] };
    breakdown: {
      header: string;
      ensName: string;
      priceLine: string;
      ownerLine: string;
      visionUrl: string;
      ownerHandle: string;
    };
  }> {
    const tweet = await this.generateRegistrationTweet(registration);
    const validation = this.validateRegistrationTweet(tweet.text);
    
    // Get account data for breakdown
    const ownerAccount = await this.getAccountData(registration.ownerAddress);

    const ensName = registration.fullName || registration.ensName || 'Unknown ENS';
    const priceEth = parseFloat(registration.costEth || '0').toFixed(2);
    const priceUsd = registration.costUsd ? `($${parseFloat(registration.costUsd).toLocaleString()})` : '';
    const ownerHandle = this.getDisplayHandle(ownerAccount, registration.ownerAddress);
    
    const breakdown = {
      header: '🏛️ Registered',
      ensName: ensName,
      priceLine: `Price: ${priceEth} ETH ${priceUsd}`.trim(),
      ownerLine: `New Owner: ${ownerHandle}`,
      visionUrl: this.buildVisionioUrl(ensName),
      ownerHandle: ownerHandle
    };

    return { tweet, validation, breakdown };
  }

  /**
   * Preview bid tweet with validation and breakdown
   */
  async previewBidTweet(bid: ENSBid): Promise<{
    tweet: GeneratedTweet;
    validation: { valid: boolean; errors: string[] };
    breakdown: {
      header: string;
      ensName: string;
      priceLine: string;
      fromLine: string;
      marketplaceLine: string;
      validLine: string;
      visionUrl: string;
      bidderHandle: string;
    };
  }> {
    const tweet = await this.generateBidTweet(bid);
    const validation = this.validateBidTweet(tweet.text);
    
    // Get account data for breakdown
    const bidderAccount = await this.getAccountData(bid.makerAddress);

    const ensName = await this.resolveENSNameFromBid(bid);
    const currencyDisplay = this.getCurrencyDisplayName(bid.currencySymbol);
    const priceDecimal = parseFloat(bid.priceDecimal).toFixed(2);
    const priceUsd = bid.priceUsd ? `($${parseFloat(bid.priceUsd).toLocaleString()})` : '';
    const bidderHandle = this.getDisplayHandle(bidderAccount, bid.makerAddress);
    const duration = this.calculateBidDuration(bid.validFrom, bid.validUntil);
    const visionUrl = this.buildVisionioUrl(ensName);
    
    const breakdown = {
      header: '✋ Offer',
      ensName: ensName,
      priceLine: `Price: ${priceDecimal} ${currencyDisplay} ${priceUsd}`.trim(),
      fromLine: `From: ${bidderHandle}`,
      marketplaceLine: `Marketplace: ${bid.sourceName || 'Unknown'}`,
      validLine: `Valid: ${duration}`,
      visionUrl: visionUrl,
      bidderHandle: bidderHandle
    };

    return { tweet, validation, breakdown };
  }
}
