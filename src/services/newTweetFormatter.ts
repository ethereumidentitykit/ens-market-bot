import { ProcessedSale, ENSRegistration, ENSBid } from '../types';
import { logger } from '../utils/logger';
import { ENSWorkerService, ENSWorkerAccount } from './ensWorkerService';
import { RealDataImageService, RealImageData } from './realDataImageService';
import { ImageData } from '../types/imageTypes';
import { PuppeteerImageService } from './puppeteerImageService';
import { IDatabaseService } from '../types';
import { AlchemyService } from './alchemyService';

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
  
  // Club detection patterns
  private readonly CLUB_10K_PATTERN = /^\d{4}\.eth$/;  // e.g., 1234.eth
  private readonly CLUB_999_PATTERN = /^\d{3}\.eth$/;  // e.g., 123.eth
  private readonly EMOJI_ONLY_PATTERN = /^(?!^\d+\.eth$)(?:[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}\p{Emoji_Presentation}\p{Extended_Pictographic}]|\u200D|\uFE0F)+\.eth$/u;  // Only emoji sequences + .eth, exclude plain digits
  private readonly ethIdentityService = new ENSWorkerService();

  constructor(
    private databaseService?: IDatabaseService,
    private alchemyService?: AlchemyService
  ) {}

  /**
   * Generate a complete tweet with text and image for an ENS registration
   */
  async generateRegistrationTweet(registration: ENSRegistration): Promise<GeneratedTweet> {
    try {
      logger.info(`Generating registration tweet for: ${registration.transactionHash}`);

      // Get account data for the new owner
      const ownerAccount = await this.getAccountData(registration.ownerAddress);

      // Generate the tweet text
      const tweetText = await this.formatRegistrationTweetText(registration, ownerAccount);
      
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
          imageBuffer = await PuppeteerImageService.generateRegistrationImage(registrationImageData, this.databaseService);
          
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
          
          // Convert RealImageData to ImageData for image generation
          const mockImageData = this.convertRealToImageDataForBid(bidImageData, bid);
          
          // Generate image buffer using Puppeteer (bid-specific)
          imageBuffer = await PuppeteerImageService.generateBidImage(mockImageData, this.databaseService);
          
          if (imageBuffer) {
            // Save image for preview
            const filename = `bid-tweet-image-${bid.id}-${Date.now()}.png`;
            const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, this.databaseService);
            
            // Set image URL based on storage location
            if (savedPath.startsWith('/api/images/')) {
              imageUrl = savedPath; // Database storage (Vercel)
            } else {
              imageUrl = `/generated-images/${filename}`; // File storage (local)
            }
            
            logger.info(`Generated bid image: ${filename}`);
          }
          
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
          
          // Convert RealImageData to ImageData for image generation
          const mockImageData = this.convertRealToImageData(saleImageData, sale);
          
          // Generate image buffer using Puppeteer
          imageBuffer = await PuppeteerImageService.generateSaleImage(mockImageData, this.databaseService);
          
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
   * Get full account data for an address using ENS Worker service
   */
  private async getAccountData(address: string): Promise<ENSWorkerAccount | null> {
    return await this.ethIdentityService.getFullAccountData(address);
  }

  /**
   * Format the tweet text for ENS registrations
   */
  private async formatRegistrationTweetText(
    registration: ENSRegistration, 
    ownerAccount: ENSWorkerAccount | null
  ): Promise<string> {
    // Header: 🏛️ REGISTERED: name.eth
    const ensName = registration.fullName || registration.ensName || 'Unknown ENS';
    const header = `🏛️ REGISTERED: ${ensName}`;
    
    // Price line: For: $X (Y ETH) (recalculate USD with fresh ETH rate)
    const priceEth = parseFloat(registration.costEth || '0').toFixed(2);
    const priceEthValue = parseFloat(registration.costEth || '0');
    
    let priceUsd = '';
    if (this.alchemyService && priceEthValue > 0) {
      try {
        const freshEthPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (freshEthPriceUsd) {
          const calculatedUsd = priceEthValue * freshEthPriceUsd;
          priceUsd = `$${calculatedUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
      } catch (error: any) {
        logger.warn('Failed to recalculate USD for registration tweet text, using database value:', error.message);
        priceUsd = registration.costUsd ? `$${parseFloat(registration.costUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
      }
    } else {
      priceUsd = registration.costUsd ? `$${parseFloat(registration.costUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    }
    
    const priceLine = priceUsd ? `For: ${priceUsd} (${priceEth} ETH)` : `For: ${priceEth} ETH`;
    
    // Minter line
    const ownerHandle = this.getDisplayHandle(ownerAccount, registration.ownerAddress);
    const ownerLine = `Minter: ${ownerHandle}`;
    
    // Club line (only if match found)
    const clubMention = this.getClubMention(ensName);
    const clubLine = clubMention ? `Club: ${this.getClubName(ensName)} ${clubMention}` : '';
    
    // Vision.io link
    const visionUrl = this.buildVisionioUrl(ensName);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n\n${ownerLine}`;
    if (clubLine) {
      tweet += `\n${clubLine}`;
    }
    tweet += `\n\n${visionUrl}`;
    
    return tweet;
  }

  /**
   * Format bid tweet text according to the bid specification
   */
  private async formatBidTweetText(
    bid: ENSBid, 
    bidderAccount: ENSWorkerAccount | null
  ): Promise<string> {
    // Line 1: ENS name - use stored name from database, with ENS service fallback
    let ensName = bid.ensName;
    
    // Debug: Show Magic Eden metadata status
    if (ensName) {
      logger.info(`✅ Magic Eden provided ENS name for bid ${bid.bidId}: ${ensName}`);
    } else {
      logger.warn(`⚠️  Magic Eden did not provide ENS name for bid ${bid.bidId} (token: ${bid.tokenId})`);
    }
    
    // If no ENS name from Magic Eden, try to fetch it ourselves
    if (!ensName && bid.tokenId) {
      try {
        logger.info(`🔍 Missing ENS name for bid ${bid.bidId}, attempting fallback lookup for token ${bid.tokenId}`);
        const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
        const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
        
        const response = await fetch(metadataUrl, { 
          signal: AbortSignal.timeout(5000) // 5 second timeout
        });
        
        if (response.ok) {
          const metadata = await response.json();
          ensName = metadata.name;
          if (ensName) {
            logger.info(`✅ Successfully resolved ENS name via fallback: ${ensName}`);
          } else {
            logger.warn(`⚠️  ENS metadata service returned no name for token ${bid.tokenId}`);
          }
        } else {
          logger.warn(`⚠️  ENS metadata service returned HTTP ${response.status} for token ${bid.tokenId}`);
        }
      } catch (error: any) {
        logger.warn(`⚠️  ENS metadata service fallback failed for token ${bid.tokenId}:`, error.message);
      }
    }
    
    // Final fallback if everything failed
    if (!ensName) {
      ensName = `Token: ${bid.tokenId?.slice(-6) || 'Unknown'}...`;
      logger.warn(`❌ No ENS name could be resolved for bid ${bid.bidId}, using fallback: ${ensName}`);
    }
    
    // Header: ✋ OFFER: name.eth
    const header = `✋ OFFER: ${ensName}`;
    
    // Price line: For: $X (Y ETH) (recalculate USD with fresh ETH rate)
    const currencyDisplay = this.getCurrencyDisplayName(bid.currencySymbol);
    const priceDecimal = parseFloat(bid.priceDecimal).toFixed(2);
    
    let priceUsd = '';
    if (this.alchemyService && (bid.currencySymbol === 'ETH' || bid.currencySymbol === 'WETH')) {
      try {
        const freshEthPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (freshEthPriceUsd) {
          const calculatedUsd = parseFloat(bid.priceDecimal) * freshEthPriceUsd;
          priceUsd = `$${calculatedUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
      } catch (error: any) {
        logger.warn('Failed to recalculate USD for tweet text, using database value:', error.message);
        priceUsd = bid.priceUsd ? `$${parseFloat(bid.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
      }
    } else {
      priceUsd = bid.priceUsd ? `$${parseFloat(bid.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    }
    
    const priceLine = priceUsd ? `For: ${priceUsd} (${priceDecimal} ${currencyDisplay})` : `For: ${priceDecimal} ${currencyDisplay}`;
    
    // Valid duration line
    const duration = this.calculateBidDuration(bid.validFrom, bid.validUntil);
    const validLine = `Valid: ${duration}`;
    
    // Bidder line
    const bidderHandle = this.getDisplayHandle(bidderAccount, bid.makerAddress);
    const bidderLine = `Bidder: ${bidderHandle}`;
    
    // Owner line (fetch the current NFT owner)
    let currentOwnerLine = 'Owner: Unknown';
    if (this.alchemyService && bid.tokenId && bid.contractAddress) {
      try {
        const owners = await this.alchemyService.getOwnersForToken(bid.contractAddress, bid.tokenId);
        if (owners && owners.length > 0) {
          const ownerAccount = await this.getAccountData(owners[0]);
          const ownerHandle = this.getDisplayHandle(ownerAccount, owners[0]);
          currentOwnerLine = `Owner: ${ownerHandle}`;
        }
      } catch (error: any) {
        logger.warn('[Alchemy API] Failed to fetch Owner for bid tweet:', error.message);
      }
    }
    
    // Club line (only if match found)
    const clubMention = this.getClubMention(ensName);
    const clubLine = clubMention ? `Club: ${this.getClubName(ensName)} ${clubMention}` : '';
    
    // Vision.io link
    const visionUrl = this.buildVisionioUrl(ensName);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n\n${validLine}\n${bidderLine}\n${currentOwnerLine}`;
    if (clubLine) {
      tweet += `\n${clubLine}`;
    }
    tweet += `\n\n${visionUrl}`;
    
    return tweet;
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
    const minutes = Math.floor(durationMs / (1000 * 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    
    if (months >= 6) return `${months} months`;
    if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
    if (weeks >= 1) return `${weeks} week${weeks > 1 ? 's' : ''}`;
    if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
    if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
    if (minutes >= 1) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    return 'less than 1 minute';
  }

  /**
   * Format the tweet text according to the new specification
   */
  private formatTweetText(
    sale: ProcessedSale, 
    buyerAccount: ENSWorkerAccount | null, 
    sellerAccount: ENSWorkerAccount | null
  ): string {
    // Header: 💰 SOLD: name.eth
    const ensName = sale.nftName || 'Unknown ENS';
    const header = `💰 SOLD: ${ensName}`;
    
    // Price line: For: $X (Y ETH) - 2 decimal places for USD in tweets
    const priceEth = parseFloat(sale.priceEth).toFixed(2);
    const priceUsd = sale.priceUsd ? `$${parseFloat(sale.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    const priceLine = priceUsd ? `For: ${priceUsd} (${priceEth} ETH)` : `For: ${priceEth} ETH`;
    
    // Buyer and Seller lines
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    const buyerLine = `Buyer: ${buyerHandle}`;
    const sellerLine = `Seller: ${sellerHandle}`;
    
    // Club line (only if match found)
    const clubMention = this.getClubMention(ensName);
    const clubLine = clubMention ? `Club: ${this.getClubName(ensName)} ${clubMention}` : '';
    
    // Vision.io link
    const visionUrl = this.buildVisionioUrl(ensName);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n\n${buyerLine}\n${sellerLine}`;
    if (clubLine) {
      tweet += `\n${clubLine}`;
    }
    tweet += `\n\n${visionUrl}`;
    
    return tweet;
  }

  /**
   * Get club mention for ENS name if applicable
   */
  private getClubMention(ensName: string): string | null {
    if (!ensName) return null;
    
    if (this.CLUB_999_PATTERN.test(ensName)) {
      return '@ENS999club';
    } else if (this.CLUB_10K_PATTERN.test(ensName)) {
      return '@10kClubOfficial';
    } else if (this.EMOJI_ONLY_PATTERN.test(ensName)) {
      return '@EthmojiClub';
    }
    
    return null;
  }

  /**
   * Get human-readable club name for ENS name if applicable
   */
  private getClubName(ensName: string): string | null {
    if (!ensName) return null;
    
    if (this.CLUB_999_PATTERN.test(ensName)) {
      return '999 Club';
    } else if (this.CLUB_10K_PATTERN.test(ensName)) {
      return '10k Club';
    } else if (this.EMOJI_ONLY_PATTERN.test(ensName)) {
      return 'Emoji Club';
    }
    
    return null;
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
    
    // URL encode the ENS name to handle emojis and special characters properly
    // This ensures complex emojis (like 👩‍🎓 with Zero Width Joiners) work in clickable links
    const encodedName = encodeURIComponent(cleanName);
    
    return `https://vision.io/name/${encodedName}.eth`;
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
  private getDisplayHandle(account: ENSWorkerAccount | null, fallbackAddress: string): string {
    if (!account) {
      return this.shortenAddress(fallbackAddress);
    }

    const ensName = account.name;
    const twitterRecord = account.records?.['com.twitter'];
    
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
   * Get display handle for images (ENS name only, no Twitter handles)
   * For images, we only want the ENS name without Twitter handles:
   * - "ensname.eth" (if ENS exists)
   * - "0xabcd...efg1" (truncated address fallback)
   */
  private getImageDisplayHandle(account: ENSWorkerAccount | null, fallbackAddress: string): string {
    if (!account) {
      return this.shortenAddress(fallbackAddress);
    }

    const ensName = account.name;
    
    if (ensName) {
      // Only return ENS name (no Twitter handle for images)
      return ensName;
    }

    // Fallback to shortened address
    return this.shortenAddress(account.address || fallbackAddress);
  }

  /**
   * Convert ENS registration to image data format for image generation
   */
  private async convertRegistrationToImageData(registration: ENSRegistration, ownerAccount: ENSWorkerAccount | null): Promise<RealImageData> {
    logger.info(`Converting registration to image data: ${registration.transactionHash}`);
    
    // Parse ETH price
    const priceEth = parseFloat(registration.costEth || '0');
    
    // Recalculate USD price with fresh ETH rate for accurate image generation
    let priceUsd = 0;
    if (this.alchemyService && priceEth > 0) {
      try {
        const freshEthPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (freshEthPriceUsd) {
          priceUsd = priceEth * freshEthPriceUsd;
          logger.debug(`💰 Recalculated USD price: ${priceEth} ETH × $${freshEthPriceUsd} = $${priceUsd.toFixed(2)}`);
        }
      } catch (error: any) {
        logger.warn('Failed to recalculate USD price, using database value:', error.message);
        priceUsd = registration.costUsd ? parseFloat(registration.costUsd) : 0;
      }
    } else {
      priceUsd = registration.costUsd ? parseFloat(registration.costUsd) : 0;
    }
    
    // Get ENS name for display
    const ensName = registration.fullName || registration.ensName || 'Unknown ENS';
    
    // Get owner display info (ENS only for images)
    const ownerHandle = this.getImageDisplayHandle(ownerAccount, registration.ownerAddress);
    const ownerAvatar = ownerAccount?.avatar || ownerAccount?.records?.avatar;
    
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
  private async convertBidToImageData(bid: ENSBid, bidderAccount: ENSWorkerAccount | null): Promise<RealImageData> {
    logger.info(`Converting bid to image data: ${bid.bidId}`);
    
    // Parse ETH price
    const priceEth = parseFloat(bid.priceDecimal);
    
    // Recalculate USD price with fresh ETH rate for accurate image generation
    let priceUsd = 0;
    if (this.alchemyService && (bid.currencySymbol === 'ETH' || bid.currencySymbol === 'WETH')) {
      try {
        const freshEthPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (freshEthPriceUsd) {
          priceUsd = priceEth * freshEthPriceUsd;
          logger.debug(`💰 Recalculated USD price: ${priceEth} ETH × $${freshEthPriceUsd} = $${priceUsd.toFixed(2)}`);
        }
      } catch (error: any) {
        logger.warn('Failed to recalculate USD price, using database value:', error.message);
        priceUsd = bid.priceUsd ? parseFloat(bid.priceUsd) : 0;
      }
    } else {
      priceUsd = bid.priceUsd ? parseFloat(bid.priceUsd) : 0;
    }
    
    // Get ENS name for display (from database), with ENS service fallback  
    let ensName = bid.ensName;
    
    // Debug: Show Magic Eden metadata status for image generation
    if (ensName) {
      logger.info(`✅ Magic Eden provided ENS name for image bid ${bid.bidId}: ${ensName}`);
    } else {
      logger.warn(`⚠️  Magic Eden did not provide ENS name for image bid ${bid.bidId} (token: ${bid.tokenId})`);
    }
    
    // If no ENS name from Magic Eden, try to fetch it ourselves (same logic as tweet text)
    if (!ensName && bid.tokenId) {
      try {
        logger.info(`🔍 Missing ENS name for image generation of bid ${bid.bidId}, attempting fallback lookup for token ${bid.tokenId}`);
        const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
        const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
        
        const response = await fetch(metadataUrl, { 
          signal: AbortSignal.timeout(5000) // 5 second timeout
        });
        
        if (response.ok) {
          const metadata = await response.json();
          ensName = metadata.name;
          if (ensName) {
            logger.info(`✅ Successfully resolved ENS name via fallback for image: ${ensName}`);
          } else {
            logger.warn(`⚠️  ENS metadata service returned no name for image token ${bid.tokenId}`);
          }
        } else {
          logger.warn(`⚠️  ENS metadata service returned HTTP ${response.status} for image token ${bid.tokenId}`);
        }
      } catch (error: any) {
        logger.warn(`⚠️  ENS metadata service fallback failed for image token ${bid.tokenId}:`, error.message);
      }
    }
    
    // Final fallback if everything failed
    if (!ensName) {
      ensName = `Token: ${bid.tokenId?.slice(-6) || 'Unknown'}...`;
      logger.warn(`❌ No ENS name could be resolved for image bid ${bid.bidId}, using fallback: ${ensName}`);
    }
    
    // Get bidder display info (ENS only for images)
    const bidderHandle = this.getImageDisplayHandle(bidderAccount, bid.makerAddress);
    const bidderAvatar = bidderAccount?.avatar || bidderAccount?.records?.avatar;
    
    // Try to get Owner using Alchemy API
    let currentOwnerEns = '';
    let currentOwnerAvatar: string | undefined;
    
    if (this.alchemyService && bid.tokenId && bid.contractAddress) {
      try {
        logger.debug(`Looking up Owner for token ${bid.tokenId}`);
        const owners = await this.alchemyService.getOwnersForToken(bid.contractAddress, bid.tokenId);
        
        if (owners.length > 0) {
          const ownerAddress = owners[0]; // ENS tokens typically have only one owner
          logger.debug(`Found Owner: ${ownerAddress}`);
          
          // Get profile info for the owner (ENS only for images)
          const ownerAccount = await this.getAccountData(ownerAddress);
          currentOwnerEns = this.getImageDisplayHandle(ownerAccount, ownerAddress);
          currentOwnerAvatar = ownerAccount?.avatar || ownerAccount?.records?.avatar;
          
          logger.debug(`Owner display: ${currentOwnerEns}, Avatar URL: ${currentOwnerAvatar}`);
        } else {
          logger.debug(`No owners found for token ${bid.tokenId}`);
        }
      } catch (error: any) {
        logger.warn(`[Alchemy API] Failed to get Owner for token ${bid.tokenId}:`, error.message);
      }
    }
    
    const imageData: RealImageData = {
      priceEth,
      priceUsd,
      ensName,
      buyerEns: bidderHandle, // Bidder is the potential "buyer"
      sellerEns: currentOwnerEns, // Owner (empty if lookup failed)
      buyerAvatar: bidderAvatar,
      sellerAvatar: currentOwnerAvatar,
      nftImageUrl: bid.nftImage, // Use ENS NFT image if available
      saleId: bid.id,
      transactionHash: bid.bidId // Use bid ID as transaction reference
    };

    logger.info('Converted bid to image data:', {
      ensName: imageData.ensName,
      bidderEns: imageData.buyerEns,
      currentOwnerEns: imageData.sellerEns,
      priceEth: imageData.priceEth,
      priceUsd: imageData.priceUsd,
      hasNftImage: !!imageData.nftImageUrl,
      hasBidderAvatar: !!imageData.buyerAvatar,
      hasCurrentOwnerAvatar: !!imageData.sellerAvatar
    });

    return imageData;
  }

  /**
   * Convert RealImageData to ImageData for image generation
   */
  private convertRealToImageData(realData: RealImageData, sale: ProcessedSale): ImageData {
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
   * Convert RealImageData to ImageData for bid image generation
   */
  private convertRealToImageDataForBid(realData: RealImageData, bid: ENSBid): ImageData {
    return {
      priceEth: realData.priceEth,
      priceUsd: realData.priceUsd,
      ensName: realData.ensName,
      nftImageUrl: realData.nftImageUrl,
      buyerAddress: bid.makerAddress, // Bidder is the potential buyer
      buyerEns: realData.buyerEns,
      buyerAvatar: realData.buyerAvatar,
      sellerAddress: '', // No seller address available for bids
      sellerEns: realData.sellerEns,
      sellerAvatar: realData.sellerAvatar,
      transactionHash: bid.bidId, // Use bid ID as transaction reference
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
    if (!content.includes('🏛️ REGISTERED:')) {
      errors.push('Registration tweet should include "🏛️ REGISTERED:" header');
    }

    if (!content.includes('For:')) {
      errors.push('Registration tweet should include "For:" label');
    }

    if (!content.includes('ETH')) {
      errors.push('Registration tweet should include price in ETH');
    }

    if (!content.includes('Minter:')) {
      errors.push('Registration tweet should include "Minter:" label');
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
    if (!content.includes('✋ OFFER:')) {
      errors.push('Bid tweet should include "✋ OFFER:" header');
    }

    if (!content.includes('For:')) {
      errors.push('Bid tweet should include "For:" label');
    }

    if (!content.includes('Bidder:')) {
      errors.push('Bid tweet should include "Bidder:" label');
    }

    if (!content.includes('Owner:')) {
      errors.push('Bid tweet should include "Owner:" label');
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
    if (!content.includes('💰 SOLD:')) {
      errors.push('Tweet should include "💰 SOLD:" header');
    }

    if (!content.includes('For:')) {
      errors.push('Tweet should include "For:" label');
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
    const priceUsd = sale.priceUsd ? `$${parseFloat(sale.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    
    // Check for club mention
    const clubMention = this.getClubMention(ensName);
    const clubName = this.getClubName(ensName);
    
    const breakdown = {
      header: `💰 SOLD: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd} (${priceEth} ETH)` : `For: ${priceEth} ETH`,
      buyerLine: `Buyer: ${buyerHandle}`,
      sellerLine: `Seller: ${sellerHandle}`,
      clubLine: clubMention ? `Club: ${clubName} ${clubMention}` : '',
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
    const priceUsd = registration.costUsd ? `($${parseFloat(registration.costUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : '';
    const ownerHandle = this.getDisplayHandle(ownerAccount, registration.ownerAddress);
    
    // Check for club mention
    const clubMention = this.getClubMention(ensName);
    const clubName = this.getClubName(ensName);
    
    const breakdown = {
      header: `🏛️ REGISTERED: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd.replace(/[()]/g, '')} (${priceEth} ETH)` : `For: ${priceEth} ETH`,
      ownerLine: `Minter: ${ownerHandle}`,
      clubLine: clubMention ? `Club: ${clubName} ${clubMention}` : '',
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
      bidderLine: string;
      currentOwnerLine: string;
      validLine: string;
      visionUrl: string;
      bidderHandle: string;
      currentOwnerHandle: string;
    };
  }> {
    const tweet = await this.generateBidTweet(bid);
    const validation = this.validateBidTweet(tweet.text);
    
    // Get account data for breakdown
    const bidderAccount = await this.getAccountData(bid.makerAddress);

    // Use consistent ENS name resolution (same logic as tweet text and image)
    let ensName = bid.ensName;
    
    // Debug: Show Magic Eden metadata status for breakdown
    if (ensName) {
      logger.info(`✅ Magic Eden provided ENS name for bid breakdown ${bid.bidId}: ${ensName}`);
    } else {
      logger.warn(`⚠️  Magic Eden did not provide ENS name for bid breakdown ${bid.bidId} (token: ${bid.tokenId})`);
    }
    
    // If no ENS name from Magic Eden, try to fetch it ourselves
    if (!ensName && bid.tokenId) {
      try {
        logger.info(`🔍 Missing ENS name for bid breakdown ${bid.bidId}, attempting fallback lookup for token ${bid.tokenId}`);
        const ensContract = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
        const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;
        
        const response = await fetch(metadataUrl, { 
          signal: AbortSignal.timeout(5000) // 5 second timeout
        });
        
        if (response.ok) {
          const metadata = await response.json();
          ensName = metadata.name;
          if (ensName) {
            logger.info(`✅ Successfully resolved ENS name via fallback for breakdown: ${ensName}`);
          }
        }
      } catch (error: any) {
        logger.warn(`⚠️  ENS metadata service fallback failed for breakdown token ${bid.tokenId}:`, error.message);
      }
    }
    
    // Final fallback if everything failed
    if (!ensName) {
      ensName = `Token: ${bid.tokenId?.slice(-6) || 'Unknown'}...`;
    }
    const currencyDisplay = this.getCurrencyDisplayName(bid.currencySymbol);
    const priceDecimal = parseFloat(bid.priceDecimal).toFixed(2);
    
    // Recalculate USD price with fresh ETH rate for breakdown (2 decimal places for tweets)
    let priceUsd = '';
    if (this.alchemyService && (bid.currencySymbol === 'ETH' || bid.currencySymbol === 'WETH')) {
      try {
        const freshEthPriceUsd = await this.alchemyService.getETHPriceUSD();
        if (freshEthPriceUsd) {
          const calculatedUsd = parseFloat(bid.priceDecimal) * freshEthPriceUsd;
          priceUsd = `$${calculatedUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }
      } catch (error: any) {
        logger.warn('Failed to recalculate USD for breakdown, using database value:', error.message);
        priceUsd = bid.priceUsd ? `$${parseFloat(bid.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
      }
    } else {
      priceUsd = bid.priceUsd ? `$${parseFloat(bid.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    }
    
    const bidderHandle = this.getDisplayHandle(bidderAccount, bid.makerAddress);
    const duration = this.calculateBidDuration(bid.validFrom, bid.validUntil);
    const visionUrl = this.buildVisionioUrl(ensName);
    
    // Fetch Owner for breakdown (same logic as in tweet text)
    let currentOwnerHandle = 'Unknown';
    if (this.alchemyService && bid.tokenId && bid.contractAddress) {
      try {
        const owners = await this.alchemyService.getOwnersForToken(bid.contractAddress, bid.tokenId);
        if (owners && owners.length > 0) {
          const ownerAccount = await this.getAccountData(owners[0]);
          currentOwnerHandle = this.getDisplayHandle(ownerAccount, owners[0]);
        }
      } catch (error: any) {
        logger.warn('[Alchemy API] Failed to fetch Owner for breakdown:', error.message);
      }
    }
    
    // Check for club mention
    const clubMention = this.getClubMention(ensName);
    const clubName = this.getClubName(ensName);
    
    const breakdown = {
      header: `✋ OFFER: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd} (${priceDecimal} ${currencyDisplay})` : `For: ${priceDecimal} ${currencyDisplay}`,
      validLine: `Valid: ${duration}`,
      bidderLine: `Bidder: ${bidderHandle}`,
      currentOwnerLine: `Owner: ${currentOwnerHandle}`,
      clubLine: clubMention ? `Club: ${clubName} ${clubMention}` : '',
      visionUrl: visionUrl,
      bidderHandle: bidderHandle,
      currentOwnerHandle: currentOwnerHandle
    };

    return { tweet, validation, breakdown };
  }
}
