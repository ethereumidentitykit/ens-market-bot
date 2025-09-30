import { ProcessedSale, ENSRegistration, ENSBid } from '../types';
import { logger } from '../utils/logger';
import { ENSWorkerService, ENSWorkerAccount } from './ensWorkerService';
import { RealDataImageService, RealImageData } from './realDataImageService';
import { ImageData } from '../types/imageTypes';
import { PuppeteerImageService } from './puppeteerImageService';
import { IDatabaseService } from '../types';
import { AlchemyService } from './alchemyService';
import { OpenSeaService } from './openSeaService';
import { ENSMetadataService } from './ensMetadataService';
import { ClubService } from './clubService';
import { MagicEdenService, HistoricalEvent, ListingPrice } from './magicEdenService';
import { ENSTokenUtils } from './ensTokenUtils';
import { TimeUtils } from '../utils/timeUtils';

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
  // Note: No longer enforcing character limit - premium account supports longer tweets
  private readonly ethIdentityService = new ENSWorkerService();
  private readonly clubService = new ClubService();

  constructor(
    private databaseService?: IDatabaseService,
    private alchemyService?: AlchemyService,
    private openSeaService?: OpenSeaService,
    private ensMetadataService?: ENSMetadataService,
    private magicEdenService?: MagicEdenService
  ) {
    logger.info('[NewTweetFormatter] Constructor called - ClubService should be initialized');
    // Add a small delay to let ClubService initialize, then check status
    setTimeout(() => {
      logger.info(`[NewTweetFormatter] ClubService initialized: ${this.clubService.isInitialized()}`);
      const stats = this.clubService.getStats();
      logger.info(`[NewTweetFormatter] ClubService stats: ${JSON.stringify(stats)}`);
    }, 1000);
  }

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
          imageBuffer = await PuppeteerImageService.generateRegistrationImage(registrationImageData, this.databaseService, this.openSeaService);
          
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
        isValid: tweetText.length > 0,
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
          imageBuffer = await PuppeteerImageService.generateBidImage(mockImageData, this.databaseService, this.openSeaService);
          
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
      const tweetText = await this.formatTweetText(sale, buyerAccount, sellerAccount);
      
      // Generate image if database service is available
      let imageBuffer: Buffer | undefined;
      let imageUrl: string | undefined;
      let imageData: RealImageData | undefined;

      if (this.databaseService) {
        try {
          logger.info(`Generating image for sale: ${sale.transactionHash}`);
          const realDataService = new RealDataImageService(this.databaseService, this.ethIdentityService, this.openSeaService);
          
          // Convert sale to image data
          const saleImageData = await realDataService.convertSaleToImageData(sale);
          
          // Convert RealImageData to ImageData for image generation
          const mockImageData = this.convertRealToImageData(saleImageData, sale);
          
          // Generate image buffer using Puppeteer
          imageBuffer = await PuppeteerImageService.generateSaleImage(mockImageData, this.databaseService, this.openSeaService);
          
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
        isValid: tweetText.length > 0,
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
   * Get historical context for sales and registrations
   */
  private async getHistoricalContext(
    contractAddress: string, 
    tokenId: string, 
    ensName: string,
    currentTxHash?: string
  ): Promise<string | null> {
    if (!this.magicEdenService) {
      logger.debug('[NewTweetFormatter] Magic Eden service not available for historical context');
      return null;
    }

    try {
      logger.info(`🔍 Fetching historical context for ${ensName} (${contractAddress}:${tokenId})`);
      
      // Check if incoming contract is one of the valid ENS token contracts
      const isNameWrapper = contractAddress.toLowerCase() === ENSTokenUtils.NAME_WRAPPER_CONTRACT.toLowerCase();
      const isEnsRegistry = contractAddress.toLowerCase() === ENSTokenUtils.ENS_REGISTRY_CONTRACT.toLowerCase();
      
      // Determine primary and fallback contracts/tokenIds
      let primaryContract: string;
      let primaryTokenId: string;
      let fallbackContract: string | null = null;
      let fallbackTokenId: string | null = null;

      if (!isNameWrapper && !isEnsRegistry) {
        // Contract is not an ENS token contract (e.g., old registrar controller)
        // Default to Name Wrapper first, then fallback to ENS Registry
        logger.debug(`⚠️ Non-ENS token contract detected: ${contractAddress}. Defaulting to Name Wrapper → ENS Registry lookup`);
        
        primaryContract = ENSTokenUtils.NAME_WRAPPER_CONTRACT;
        primaryTokenId = ENSTokenUtils.ensNameToNamehash(ensName); // Wrapped tokens use namehash
        
        fallbackContract = ENSTokenUtils.ENS_REGISTRY_CONTRACT;
        fallbackTokenId = ENSTokenUtils.ensNameToLabelhash(ensName); // Unwrapped tokens use labelhash
        
      } else if (isNameWrapper) {
        // Valid Name Wrapper contract - use as-is with ENS Registry fallback
        primaryContract = contractAddress;
        primaryTokenId = tokenId;
        
        fallbackContract = ENSTokenUtils.ENS_REGISTRY_CONTRACT;
        fallbackTokenId = ENSTokenUtils.ensNameToLabelhash(ensName);
        logger.debug(`🔄 Will fallback to unwrapped lookup if no wrapped history found`);
        
      } else {
        // Valid ENS Registry contract - use as-is with no fallback
        primaryContract = contractAddress;
        primaryTokenId = tokenId;
        // Note: No fallback from ENS Registry to Name Wrapper (unwrapped tokens won't have wrapped history)
      }


      // Try primary lookup first
      const primaryResult = await this.magicEdenService.getLastSaleOrRegistration(
        primaryContract, 
        primaryTokenId,
        currentTxHash
      );

      if (primaryResult) {
        logger.info(`✅ Found historical data from primary contract: ${primaryResult.priceEth} ${primaryResult.currencySymbol || 'ETH'}`);
        return TimeUtils.formatHistoricalEvent(Number(primaryResult.priceEth), primaryResult.timestamp, primaryResult.type, primaryResult.currencySymbol);
      }

      // Try fallback lookup if configured
      if (fallbackContract && fallbackTokenId) {
        logger.info(`🔄 Trying fallback lookup: ${fallbackContract}:${fallbackTokenId}`);
        const fallbackResult = await this.magicEdenService.getLastSaleOrRegistration(
          fallbackContract,
          fallbackTokenId,
          currentTxHash
        );

        if (fallbackResult) {
          logger.info(`✅ Found historical data from fallback contract: ${fallbackResult.priceEth} ${fallbackResult.currencySymbol || 'ETH'}`);
          return TimeUtils.formatHistoricalEvent(Number(fallbackResult.priceEth), fallbackResult.timestamp, fallbackResult.type, fallbackResult.currencySymbol);
        }
      }

      logger.info(`ℹ️ No historical context found for ${ensName}`);
      return null;

    } catch (error: any) {
      logger.warn(`⚠️ Failed to fetch historical context for ${ensName}:`, error.message);
      return null;
    }
  }

  /**
   * Get current listing price context for bids
   */
  private async getListingContext(
    contractAddress: string,
    tokenId: string,
    bidAmountEth: number
  ): Promise<string | null> {
    if (!this.magicEdenService) {
      logger.debug('[NewTweetFormatter] Magic Eden service not available for listing context');
      return null;
    }

    try {
      logger.info(`🔍 Fetching listing context for ${contractAddress}:${tokenId}`);

      const listingData = await this.magicEdenService.getCurrentListingPrice(
        contractAddress,
        tokenId,
        bidAmountEth
      );

      if (listingData) {
        logger.info(`✅ Found active listing: ${listingData.priceEth} ETH`);
        return `List Price: ${Number(listingData.priceEth).toFixed(2)} ETH`;
      }

      logger.info('ℹ️ No active listing found or bid not within proximity threshold');
      return null;

    } catch (error: any) {
      logger.warn('⚠️ Failed to fetch listing context:', error.message);
      return null;
    }
  }

  /**
   * Format the tweet text for ENS registrations
   */
  private async formatRegistrationTweetText(
    registration: ENSRegistration, 
    ownerAccount: ENSWorkerAccount | null
  ): Promise<string> {
    // Header: 🏛️ REGISTERED: name.eth
    const rawEnsName = registration.fullName || registration.ensName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
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
    
    // Historical context line (NEW)
    let historicalLine = '';
    if (registration.contractAddress && registration.tokenId) {
      const historical = await this.getHistoricalContext(
        registration.contractAddress,
        registration.tokenId,
        ensName,
        registration.transactionHash
      );
      if (historical) {
        historicalLine = historical;
      }
    } else {
      logger.warn(`⚠️ Missing required data for historical context: contractAddress=${registration.contractAddress}, tokenId=${registration.tokenId}`);
    }
    
    // Minter line
    const ownerHandle = this.getDisplayHandle(ownerAccount, registration.ownerAddress);
    const ownerLine = `Minter: ${ownerHandle}`;
    
    // Club line (show club name with handle properly paired)
    const formattedClubString = this.clubService.getFormattedClubString(ensName);
    const clubLine = formattedClubString ? `Club: ${formattedClubString}` : '';
    
    // OpenSea link
    const openSeaUrl = await this.buildOpenSeaUrl(ensName, registration.contractAddress, registration.tokenId);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n${ownerLine}`;
    if (historicalLine) {
      tweet += `\n\n${historicalLine}`;
    }
    if (clubLine) {
      tweet += `\n${clubLine}`;
    }
    if (openSeaUrl) {
      tweet += `\n\n${openSeaUrl}`;
    }
    
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
    
    // If no ENS name from Magic Eden, try to fetch it ourselves using OpenSea + ENS fallback
    if (!ensName && bid.tokenId && bid.contractAddress) {
      try {
        logger.info(`🔍 Missing ENS name for bid ${bid.bidId}, attempting fallback lookup for token ${bid.tokenId}`);
        
        // Try OpenSea first
        let metadata = null;
        if (this.openSeaService) {
          try {
            metadata = await this.openSeaService.getSimplifiedMetadata(bid.contractAddress, bid.tokenId);
            if (metadata?.name) {
              ensName = metadata.name;
              logger.info(`✅ Fetched ENS name from OpenSea: ${ensName}`);
            }
          } catch (error: any) {
            logger.warn(`⚠️ OpenSea metadata failed for bid ${bid.bidId}: ${error.message}`);
          }
        }
        
        // Fallback to ENS metadata API if OpenSea failed
        if (!ensName && this.ensMetadataService) {
          const ensContract = bid.contractAddress || '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
          logger.debug(`🔗 Falling back to ENS metadata service with contract ${ensContract}`);
          
          const ensMetadata = await this.ensMetadataService.getMetadata(ensContract, bid.tokenId);
          if (ensMetadata?.name) {
            ensName = ensMetadata.name;
            logger.info(`✅ Successfully resolved ENS name via ENS metadata fallback: ${ensName}`);
          } else {
            logger.warn(`⚠️ ENS metadata service returned no name for token ${bid.tokenId}`);
          }
        }
      } catch (error: any) {
        logger.warn(`⚠️ Metadata fallback failed for token ${bid.tokenId}:`, error.message);
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
    
    // Listing context line (NEW)
    let listingLine = '';
    if (bid.contractAddress && bid.tokenId && (bid.currencySymbol === 'ETH' || bid.currencySymbol === 'WETH')) {
      const bidAmountEth = parseFloat(bid.priceDecimal);
      const listing = await this.getListingContext(
        bid.contractAddress,
        bid.tokenId,
        bidAmountEth
      );
      if (listing) {
        listingLine = listing;
      }
    }

    // Historical context line (NEW for bids)
    let historicalLine = '';
    if (bid.contractAddress && bid.tokenId) {
      const historical = await this.getHistoricalContext(
        bid.contractAddress,
        bid.tokenId,
        ensName
        // Note: Bids don't have a transactionHash to exclude since they're offers, not completed transactions
      );
      if (historical) {
        historicalLine = historical;
      }
    }
    
    // Bidder line
    const bidderHandle = this.getDisplayHandle(bidderAccount, bid.makerAddress);
    const bidderLine = `Bidder: ${bidderHandle}`;
    
    // Owner line (fetch the current NFT owner using OpenSea first, Alchemy fallback)
    let currentOwnerLine = 'Owner: Unknown';
    if (bid.tokenId && bid.contractAddress) {
      let ownerAddress: string | null = null;
      
      // Try OpenSea first
      if (this.openSeaService) {
        try {
          ownerAddress = await this.openSeaService.getTokenOwner(bid.contractAddress, bid.tokenId);
        } catch (error: any) {
          logger.warn('[OpenSea API] Failed to fetch Owner for bid tweet:', error.message);
        }
      }
      
      // Fallback to Alchemy
      if (!ownerAddress && this.alchemyService) {
        try {
          const owners = await this.alchemyService.getOwnersForToken(bid.contractAddress, bid.tokenId);
          if (owners && owners.length > 0) {
            ownerAddress = owners[0];
          }
        } catch (error: any) {
          logger.warn('[Alchemy API] Failed to fetch Owner for bid tweet:', error.message);
        }
      }
      
      // Get display handle if owner found
      if (ownerAddress) {
        try {
          const ownerAccount = await this.getAccountData(ownerAddress);
          const ownerHandle = this.getDisplayHandle(ownerAccount, ownerAddress);
          currentOwnerLine = `Owner: ${ownerHandle}`;
        } catch (error: any) {
          logger.warn('Failed to get owner display handle:', error.message);
        }
      }
    }
    
    // Club line (show club name with handle properly paired)
    const formattedClubString = this.clubService.getFormattedClubString(ensName);
    const clubLine = formattedClubString ? `Club: ${formattedClubString}` : '';
    
    // OpenSea link
    const openSeaUrl = await this.buildOpenSeaUrl(ensName, bid.contractAddress, bid.tokenId);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n${bidderLine}\n\n${currentOwnerLine}`;
    if (listingLine) {
      tweet += `\n${listingLine}`;
    }
    if (historicalLine) {
      tweet += `\n${historicalLine}`;
    }
    if (clubLine) {
      tweet += `\n${clubLine}`;
    }
    if (openSeaUrl) {
      tweet += `\n\n${openSeaUrl}`;
    }
    
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
  private async formatTweetText(
    sale: ProcessedSale, 
    buyerAccount: ENSWorkerAccount | null, 
    sellerAccount: ENSWorkerAccount | null
  ): Promise<string> {
    // Header: 💰 SOLD: name.eth
    const rawEnsName = sale.nftName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
    const header = `💰 SOLD: ${ensName}`;
    
    // Price line: For: $X (Y ETH) - 2 decimal places for USD in tweets
    const priceEth = parseFloat(sale.priceEth).toFixed(2);
    const priceUsd = sale.priceUsd ? `$${parseFloat(sale.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    const priceLine = priceUsd ? `For: ${priceUsd} (${priceEth} ETH)` : `For: ${priceEth} ETH`;
    
    // Historical context line (NEW)
    let historicalLine = '';
    if (sale.contractAddress && sale.tokenId) {
      const historical = await this.getHistoricalContext(
        sale.contractAddress,
        sale.tokenId,
        ensName,
        sale.transactionHash
      );
      if (historical) {
        historicalLine = historical;
      }
    } else {
      logger.warn(`⚠️ Missing required data for historical context: contractAddress=${sale.contractAddress}, tokenId=${sale.tokenId}`);
    }
    
    // Buyer and Seller lines
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    const buyerLine = `Buyer: ${buyerHandle}`;
    const sellerLine = `Seller: ${sellerHandle}`;
    
    // Club line (show club name with handle properly paired)
    logger.info(`[NewTweetFormatter] Getting club info for sale: ${ensName}`);
    logger.info(`[NewTweetFormatter] ClubService instance exists: ${!!this.clubService}`);
    logger.info(`[NewTweetFormatter] ClubService initialized: ${this.clubService?.isInitialized()}`);
    const formattedClubString = this.clubService.getFormattedClubString(ensName);
    const clubLine = formattedClubString ? `Club: ${formattedClubString}` : '';
    logger.info(`[NewTweetFormatter] Sale club line result: "${clubLine}"`);
    
    // OpenSea link
    const openSeaUrl = await this.buildOpenSeaUrl(ensName, sale.contractAddress, sale.tokenId);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n${buyerLine}\n\n${sellerLine}`;
    if (historicalLine) {
      tweet += `\n${historicalLine}`;
    }
    if (clubLine) {
      tweet += `\n${clubLine}`;
    }
    if (openSeaUrl) {
      tweet += `\n\n${openSeaUrl}`;
    }
    
    return tweet;
  }

  /**
   * Get club mention for ENS name if applicable
   * Supports multiple clubs with comma separation
   */
  private getClubMention(ensName: string): string | null {
    return this.clubService.getClubMention(ensName);
  }

  /**
   * Get human-readable club name for ENS name if applicable
   * Supports multiple clubs with comma separation
   */
  private getClubName(ensName: string): string | null {
    return this.clubService.getClubName(ensName);
  }

  /**
   * Clean ENS name by removing any data after .eth and normalizing emoji
   * Database/API sources may have normalization warnings and non-normalized emoji
   * Follows ENSIP-15 normalization: strips FE0F variation selectors from emoji
   */
  private cleanEnsName(ensName: string): string {
    if (!ensName) return ensName;
    
    // Step 1: Remove content after .eth (warning labels)
    const ethIndex = ensName.toLowerCase().indexOf('.eth');
    let cleanName = ethIndex !== -1 ? ensName.substring(0, ethIndex + 4) : ensName;
    
    // Step 2: Apply ENSIP-15 emoji normalization - strip FE0F variation selectors
    // These are not part of normalized ENS names according to ENS protocol
    cleanName = cleanName.replace(/\uFE0F/g, '');
    
    return cleanName;
  }

  /**
   * Build OpenSea marketplace URL for an ENS name
   * Format: opensea.io/item/ethereum/{contract}/{tokenId}
   * 
   * Tries both Base Registrar and NameWrapper contracts to find the correct one
   * Defaults to Base Registrar if both fail or timeout
   */
  private async buildOpenSeaUrl(ensName: string, contractAddress?: string, tokenId?: string): Promise<string> {
    // Handle cases where ensName might be "Unknown ENS" or similar error states
    const cleanName = ensName.replace(/\.eth$/i, '').trim();
    if (!cleanName || 
        cleanName.toLowerCase() === 'unknown' || 
        cleanName.toLowerCase() === 'ens' ||
        cleanName.toLowerCase() === 'unknown ens') {
      return ''; // No link for problematic cases
    }
    
    // Require tokenId for OpenSea URL
    if (!tokenId) {
      logger.warn(`⚠️ Missing tokenId for OpenSea URL: ${ensName}`);
      return '';
    }
    
    const ENS_BASE_REGISTRAR = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
    const ENS_NAME_WRAPPER = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
    const TIMEOUT_MS = 3000; // 3 second timeout per attempt
    
    // Helper to check if NFT exists on OpenSea with timeout
    const checkExists = async (contract: string, tid: string): Promise<boolean> => {
      if (!this.openSeaService) return false;
      
      try {
        const timeoutPromise = new Promise<null>((_, reject) => 
          setTimeout(() => reject(new Error('Timeout')), TIMEOUT_MS)
        );
        
        const metadataPromise = this.openSeaService.getSimplifiedMetadata(contract, tid);
        const result = await Promise.race([metadataPromise, timeoutPromise]);
        
        return result !== null;
      } catch (error: any) {
        logger.debug(`OpenSea check failed for ${contract}/${tid}: ${error.message}`);
        return false;
      }
    };
    
    // 1. Try Base Registrar with provided tokenId (labelhash)
    logger.debug(`🔍 Checking OpenSea for Base Registrar: ${ensName}`);
    const baseExists = await checkExists(ENS_BASE_REGISTRAR, tokenId);
    if (baseExists) {
      logger.debug(`✅ Found on Base Registrar: ${ensName}`);
      return `https://opensea.io/item/ethereum/${ENS_BASE_REGISTRAR}/${tokenId}`;
    }
    
    // 2. Try NameWrapper with calculated namehash
    const fullEnsName = ensName.endsWith('.eth') ? ensName : `${ensName}.eth`;
    const namehashTokenId = BigInt(ENSTokenUtils.getTokenIdForContract(ENS_NAME_WRAPPER, fullEnsName)).toString();
    
    logger.debug(`🔍 Checking OpenSea for NameWrapper: ${ensName}`);
    const wrapperExists = await checkExists(ENS_NAME_WRAPPER, namehashTokenId);
    if (wrapperExists) {
      logger.debug(`✅ Found on NameWrapper: ${ensName}`);
      return `https://opensea.io/item/ethereum/${ENS_NAME_WRAPPER}/${namehashTokenId}`;
    }
    
    // 3. Default to Base Registrar if both failed/timeout
    logger.debug(`⚠️ Neither contract verified for ${ensName}, defaulting to Base Registrar`);
    return `https://opensea.io/item/ethereum/${ENS_BASE_REGISTRAR}/${tokenId}`;
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
    const rawEnsName = registration.fullName || registration.ensName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
    
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
      transactionHash: registration.transactionHash,
      contractAddress: registration.contractAddress,
      tokenId: registration.tokenId
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
    
    // If no ENS name from Magic Eden, try to fetch it ourselves using OpenSea + ENS fallback
    if (!ensName && bid.tokenId && bid.contractAddress) {
      try {
        logger.info(`🔍 Missing ENS name for image generation of bid ${bid.bidId}, attempting fallback lookup for token ${bid.tokenId}`);
        
        // Try OpenSea first
        let metadata = null;
        if (this.openSeaService) {
          try {
            metadata = await this.openSeaService.getSimplifiedMetadata(bid.contractAddress, bid.tokenId);
            if (metadata?.name) {
              ensName = metadata.name;
              logger.info(`✅ Fetched ENS name from OpenSea for image: ${ensName}`);
            }
          } catch (error: any) {
            logger.warn(`⚠️ OpenSea metadata failed for image bid ${bid.bidId}: ${error.message}`);
          }
        }
        
        // Fallback to ENS metadata API if OpenSea failed
        if (!ensName && this.ensMetadataService) {
          const ensContract = bid.contractAddress || '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
          logger.debug(`🔗 Falling back to ENS metadata service for image with contract ${ensContract}`);
          
          const ensMetadata = await this.ensMetadataService.getMetadata(ensContract, bid.tokenId);
          if (ensMetadata?.name) {
            ensName = ensMetadata.name;
            logger.info(`✅ Successfully resolved ENS name via ENS metadata fallback for image: ${ensName}`);
          } else {
            logger.warn(`⚠️ ENS metadata service returned no name for image token ${bid.tokenId}`);
          }
        }
      } catch (error: any) {
        logger.warn(`⚠️ Metadata fallback failed for image token ${bid.tokenId}:`, error.message);
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
    
    // Try to get Owner using OpenSea API first, then Alchemy fallback
    let currentOwnerEns = '';
    let currentOwnerAvatar: string | undefined;
    
    if (bid.tokenId && bid.contractAddress) {
      let ownerAddress: string | null = null;
      
      // Try OpenSea first
      if (this.openSeaService) {
        try {
          logger.debug(`Looking up Owner for token ${bid.tokenId} via OpenSea`);
          ownerAddress = await this.openSeaService.getTokenOwner(bid.contractAddress, bid.tokenId);
          
          if (ownerAddress) {
            logger.debug(`Found Owner via OpenSea: ${ownerAddress}`);
          } else {
            logger.debug(`No owner found via OpenSea for token ${bid.tokenId}`);
          }
        } catch (error: any) {
          logger.warn(`[OpenSea API] Failed to get Owner for token ${bid.tokenId}:`, error.message);
        }
      }
      
      // Fallback to Alchemy if OpenSea failed
      if (!ownerAddress && this.alchemyService) {
        try {
          logger.debug(`Falling back to Alchemy for Owner lookup of token ${bid.tokenId}`);
          const owners = await this.alchemyService.getOwnersForToken(bid.contractAddress, bid.tokenId);
          
          if (owners.length > 0) {
            ownerAddress = owners[0]; // ENS tokens typically have only one owner
            logger.debug(`Found Owner via Alchemy fallback: ${ownerAddress}`);
          } else {
            logger.debug(`No owners found via Alchemy for token ${bid.tokenId}`);
          }
        } catch (error: any) {
          logger.warn(`[Alchemy API] Failed to get Owner for token ${bid.tokenId}:`, error.message);
        }
      }
      
      // If we found an owner, get their profile info
      if (ownerAddress) {
        try {
          const ownerAccount = await this.getAccountData(ownerAddress);
          currentOwnerEns = this.getImageDisplayHandle(ownerAccount, ownerAddress);
          currentOwnerAvatar = ownerAccount?.avatar || ownerAccount?.records?.avatar;
          
          logger.debug(`Owner display: ${currentOwnerEns}, Avatar URL: ${currentOwnerAvatar}`);
        } catch (error: any) {
          logger.warn(`Failed to get profile data for owner ${ownerAddress}:`, error.message);
        }
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
      transactionHash: bid.bidId, // Use bid ID as transaction reference
      contractAddress: bid.contractAddress,
      tokenId: bid.tokenId
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
      timestamp: new Date(), // Use current timestamp
      contractAddress: sale.contractAddress,
      tokenId: sale.tokenId
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
      timestamp: new Date(), // Use current timestamp
      contractAddress: bid.contractAddress,
      tokenId: bid.tokenId
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

    // No longer enforcing character limit - premium account supports longer tweets

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

    // OpenSea link is optional - only check if ENS name is valid (not "unknown" etc.)
    const ensName = content.match(/(\w+)\.eth/)?.[0] || '';
    const shouldHaveLink = ensName && 
                          !ensName.toLowerCase().includes('unknown') && 
                          ensName.toLowerCase() !== 'ens.eth';
    
    if (shouldHaveLink && !content.includes('opensea.io')) {
      errors.push('Registration tweet should include OpenSea link');
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

    // No longer enforcing character limit - premium account supports longer tweets

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


    // OpenSea link is optional - only check if ENS name is valid (not "unknown" etc.)
    const ensName = content.match(/(\w+)\.eth/)?.[0] || '';
    const shouldHaveLink = ensName && 
                          !ensName.toLowerCase().includes('unknown') && 
                          ensName.toLowerCase() !== 'ens.eth';
    
    if (shouldHaveLink && !content.includes('opensea.io')) {
      errors.push('Bid tweet should include OpenSea link');
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

    // No longer enforcing character limit - premium account supports longer tweets

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

    // OpenSea link is optional - only check if ENS name is valid (not "unknown" etc.)
    const ensName = content.match(/(\w+)\.eth/)?.[0] || '';
    const shouldHaveLink = ensName && 
                          !ensName.toLowerCase().includes('unknown') && 
                          ensName.toLowerCase() !== 'ens.eth';
    
    if (shouldHaveLink && !content.includes('opensea.io')) {
      errors.push('Tweet should include OpenSea link');
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
      openSeaUrl: string;
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

    const rawEnsName = sale.nftName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
    const priceEth = parseFloat(sale.priceEth).toFixed(2);
    const priceUsd = sale.priceUsd ? `$${parseFloat(sale.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    
    // Check for club mention
    logger.info(`[NewTweetFormatter] Preview - Getting club info for: ${ensName}`);
    logger.info(`[NewTweetFormatter] Preview - ClubService instance exists: ${!!this.clubService}`);
    logger.info(`[NewTweetFormatter] Preview - ClubService initialized: ${this.clubService?.isInitialized()}`);
    const formattedClubString = this.clubService.getFormattedClubString(ensName);
    const clubLine = formattedClubString ? `Club: ${formattedClubString}` : '';
    logger.info(`[NewTweetFormatter] Preview club line result: "${clubLine}"`);
    
    const breakdown = {
      header: `💰 SOLD: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd} (${priceEth} ETH)` : `For: ${priceEth} ETH`,
      buyerLine: `Buyer: ${buyerHandle}`,
      sellerLine: `Seller: ${sellerHandle}`,
      clubLine: clubLine,
      openSeaUrl: await this.buildOpenSeaUrl(ensName, sale.contractAddress, sale.tokenId),
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
      openSeaUrl: string;
      ownerHandle: string;
    };
  }> {
    const tweet = await this.generateRegistrationTweet(registration);
    const validation = this.validateRegistrationTweet(tweet.text);
    
    // Get account data for breakdown
    const ownerAccount = await this.getAccountData(registration.ownerAddress);

    const rawEnsName = registration.fullName || registration.ensName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
    const priceEth = parseFloat(registration.costEth || '0').toFixed(2);
    const priceUsd = registration.costUsd ? `($${parseFloat(registration.costUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : '';
    const ownerHandle = this.getDisplayHandle(ownerAccount, registration.ownerAddress);
    
    // Check for club mention
    const formattedClubString = this.clubService.getFormattedClubString(ensName);
    const clubLine = formattedClubString ? `Club: ${formattedClubString}` : '';
    
    const breakdown = {
      header: `🏛️ REGISTERED: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd.replace(/[()]/g, '')} (${priceEth} ETH)` : `For: ${priceEth} ETH`,
      ownerLine: `Minter: ${ownerHandle}`,
      clubLine: clubLine,
      openSeaUrl: await this.buildOpenSeaUrl(ensName, registration.contractAddress, registration.tokenId),
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
      openSeaUrl: string;
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
    
    // If no ENS name from Magic Eden, try to fetch it ourselves using OpenSea + ENS fallback
    if (!ensName && bid.tokenId && bid.contractAddress) {
      try {
        logger.info(`🔍 Missing ENS name for bid breakdown ${bid.bidId}, attempting fallback lookup for token ${bid.tokenId}`);
        
        // Try OpenSea first
        let metadata = null;
        if (this.openSeaService) {
          try {
            metadata = await this.openSeaService.getSimplifiedMetadata(bid.contractAddress, bid.tokenId);
            if (metadata?.name) {
              ensName = metadata.name;
              logger.info(`✅ Fetched ENS name from OpenSea for breakdown: ${ensName}`);
            }
          } catch (error: any) {
            logger.warn(`⚠️ OpenSea metadata failed for breakdown bid ${bid.bidId}: ${error.message}`);
          }
        }
        
        // Fallback to ENS metadata API if OpenSea failed
        if (!ensName && this.ensMetadataService) {
          const ensContract = bid.contractAddress || '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
          logger.debug(`🔗 Falling back to ENS metadata service for breakdown with contract ${ensContract}`);
          
          const ensMetadata = await this.ensMetadataService.getMetadata(ensContract, bid.tokenId);
          if (ensMetadata?.name) {
            ensName = ensMetadata.name;
            logger.info(`✅ Successfully resolved ENS name via ENS metadata fallback for breakdown: ${ensName}`);
          } else {
            logger.warn(`⚠️ ENS metadata service returned no name for breakdown token ${bid.tokenId}`);
          }
        }
      } catch (error: any) {
        logger.warn(`⚠️ Metadata fallback failed for breakdown token ${bid.tokenId}:`, error.message);
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
    const openSeaUrl = await this.buildOpenSeaUrl(ensName, bid.contractAddress, bid.tokenId);
    
    // Fetch Owner for breakdown (using OpenSea first, Alchemy fallback)
    let currentOwnerHandle = 'Unknown';
    if (bid.tokenId && bid.contractAddress) {
      let ownerAddress: string | null = null;
      
      // Try OpenSea first
      if (this.openSeaService) {
        try {
          ownerAddress = await this.openSeaService.getTokenOwner(bid.contractAddress, bid.tokenId);
        } catch (error: any) {
          logger.warn('[OpenSea API] Failed to fetch Owner for breakdown:', error.message);
        }
      }
      
      // Fallback to Alchemy
      if (!ownerAddress && this.alchemyService) {
        try {
          const owners = await this.alchemyService.getOwnersForToken(bid.contractAddress, bid.tokenId);
          if (owners && owners.length > 0) {
            ownerAddress = owners[0];
          }
        } catch (error: any) {
          logger.warn('[Alchemy API] Failed to fetch Owner for breakdown:', error.message);
        }
      }
      
      // Get display handle if owner found
      if (ownerAddress) {
        try {
          const ownerAccount = await this.getAccountData(ownerAddress);
          currentOwnerHandle = this.getDisplayHandle(ownerAccount, ownerAddress);
        } catch (error: any) {
          logger.warn('Failed to get owner display handle for breakdown:', error.message);
        }
      }
    }
    
    // Check for club mention
    const formattedClubString = this.clubService.getFormattedClubString(ensName);
    const clubLine = formattedClubString ? `Club: ${formattedClubString}` : '';
    
    const breakdown = {
      header: `✋ OFFER: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd} (${priceDecimal} ${currencyDisplay})` : `For: ${priceDecimal} ${currencyDisplay}`,
      validLine: `Valid: ${duration}`,
      bidderLine: `Bidder: ${bidderHandle}`,
      currentOwnerLine: `Owner: ${currentOwnerHandle}`,
      clubLine: clubLine,
      openSeaUrl: openSeaUrl,
      bidderHandle: bidderHandle,
      currentOwnerHandle: currentOwnerHandle
    };

    return { tweet, validation, breakdown };
  }
}
