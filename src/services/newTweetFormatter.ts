import { ProcessedSale, ENSRegistration, ENSBid, ENSRenewal } from '../types';
import { logger } from '../utils/logger';
import { ENSWorkerService, ENSWorkerAccount } from './ensWorkerService';
import { RealDataImageService, RealImageData } from './realDataImageService';
import { ImageData, RenewalImageData, RenewalNameCard } from '../types/imageTypes';
import { PuppeteerImageService } from './puppeteerImageService';
import { IDatabaseService } from '../types';
import { AlchemyService } from './alchemyService';
import { OpenSeaService } from './openSeaService';
import { ENSMetadataService } from './ensMetadataService';
import { ClubService } from './clubService';
import { GrailsApiService } from './grailsApiService';
import { ENSTokenUtils } from './ensTokenUtils';
import { TimeUtils } from '../utils/timeUtils';
import { calculateBidDuration, getCurrencyDisplayName } from '../utils/bidUtils';
import { isKnownMarketplaceFee } from '../config/contracts';

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
    private ensMetadataService?: ENSMetadataService
  ) {
    logger.info('[NewTweetFormatter] Constructor called');
  }

  /**
   * Generate a complete tweet with text and image for an ENS registration
   */
  async generateRegistrationTweet(registration: ENSRegistration): Promise<GeneratedTweet> {
    try {
      logger.info(`Generating registration tweet for: ${registration.transactionHash}`);

      // Get account data for the minter (executor if available, otherwise owner)
      const minterAddress = registration.executorAddress || registration.ownerAddress;
      const minterAccount = await this.getAccountData(minterAddress);

      // Generate the tweet text
      const tweetText = await this.formatRegistrationTweetText(registration, minterAccount, minterAddress);
      
      // Generate image if database service is available
      let imageBuffer: Buffer | undefined;
      let imageUrl: string | undefined;
      let imageData: RealImageData | undefined;

      if (this.databaseService) {
        try {
          logger.info(`Generating registration image for: ${registration.transactionHash}`);
          
          // Convert registration to image data format
          const registrationImageData = await this.convertRegistrationToImageData(registration, minterAccount, minterAddress);
          
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
   * Generate a complete renewal tweet (text + image) for a single transaction.
   *
   * Tweet text mirrors the structured registration format:
   *   🔁 RENEWED: name.eth  (or "🔁 RENEWED: 10 names")
   *   For: $X,XXX.XX (Y.YY ETH)
   *   Owner: name.eth @handle
   *   Renewer: renewer.eth @handle   ← only if renewer ≠ owner
   *   Top: name1.eth, name2.eth, name3.eth, +7 more   ← only for bulk
   *   Categories: ...
   *   grails.app/name.eth
   *
   * @param renewals All renewal rows belonging to a single transaction (must share tx_hash).
   */
  async generateRenewalTweet(renewals: ENSRenewal[]): Promise<GeneratedTweet> {
    if (renewals.length === 0) {
      return { text: '', characterCount: 0, isValid: false };
    }

    try {
      const sample = renewals[0];
      logger.info(`Generating renewal tweet for tx: ${sample.transactionHash} (${renewals.length} name(s))`);

      // Resolve renewer profile (ENS name + avatar). All rows in the tx share the renewer.
      const renewerAccount = await this.getAccountData(sample.renewerAddress);

      // Sort all rows by per-name cost desc — top entries drive both text breakdown and image cards.
      const sorted = [...renewals].sort((a, b) => {
        const ae = parseFloat(a.costEth || '0');
        const be = parseFloat(b.costEth || '0');
        return be - ae;
      });

      const totalEth = sorted.reduce((sum, r) => sum + parseFloat(r.costEth || '0'), 0);
      let totalUsd = sorted.reduce((sum, r) => sum + parseFloat(r.costUsd || '0'), 0);
      if (totalUsd === 0 && this.alchemyService && totalEth > 0) {
        try {
          const ethPriceUsd = await this.alchemyService.getETHPriceUSD();
          if (ethPriceUsd) {
            totalUsd = totalEth * ethPriceUsd;
            logger.debug(`💰 Recalculated renewal USD: ${totalEth} ETH × $${ethPriceUsd} = $${totalUsd.toFixed(2)}`);
          }
        } catch (error: any) {
          logger.warn('Failed to recalculate renewal USD price:', error.message);
        }
      }

      // ----- Tweet text (structured format mirroring registrations) -----
      const tweetText = await this.formatRenewalTweetText(sorted, renewerAccount, sample.renewerAddress, totalEth, totalUsd);

      // ----- Image generation -----

      let imageBuffer: Buffer | undefined;
      let imageUrl: string | undefined;
      let imageData: RealImageData | undefined; // Kept on the GeneratedTweet shape for backward compat with siblings

      if (this.databaseService) {
        try {
          logger.info(`Generating renewal image for tx: ${sample.transactionHash}`);
          const renewalImageData = await this.convertRenewalToImageData(
            sorted,
            renewerAccount,
            sample.renewerAddress,
            totalEth,
            totalUsd
          );

          imageBuffer = await PuppeteerImageService.generateRenewalImage(
            renewalImageData,
            this.databaseService,
            this.openSeaService
          );

          if (imageBuffer) {
            // Save image for preview (filename keyed by tx hash + timestamp)
            const filename = `renewal-tweet-image-${sample.transactionHash.slice(2, 12)}-${Date.now()}.png`;
            const savedPath = await PuppeteerImageService.saveImageToFile(imageBuffer, filename, this.databaseService);
            imageUrl = savedPath.startsWith('/api/images/')
              ? savedPath
              : `/generated-images/${filename}`;
            logger.info(`Generated renewal image: ${filename}`);
          }
        } catch (imageError: any) {
          logger.error('Error generating image for renewal tweet:', imageError.message);
          // Continue without image — text tweet is still valid
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

      logger.info(`Generated renewal tweet: ${result.characterCount} chars, valid: ${result.isValid}, hasImage: ${!!result.imageBuffer}, names: ${sorted.length}`);
      return result;

    } catch (error: any) {
      logger.error('Error generating renewal tweet:', error.message);
      return { text: '', characterCount: 0, isValid: false };
    }
  }

  /**
   * Convert renewal rows + renewer profile to the structured RenewalImageData
   * the Puppeteer template consumes. The grid layout is selected downstream
   * based on topNames.length (1 / 2 / 3 / 4+).
   */
  private async convertRenewalToImageData(
    sortedRenewals: ENSRenewal[],
    renewerAccount: ENSWorkerAccount | null,
    renewerAddress: string,
    totalEth: number,
    totalUsd: number
  ): Promise<RenewalImageData> {
    const sample = sortedRenewals[0];
    logger.debug(`Converting renewal tx ${sample.transactionHash} to image data (${sortedRenewals.length} names)`);

    // Take up to 3 cards for display; anything beyond becomes "+N more" overflow.
    const topRenewals = sortedRenewals.slice(0, 3);
    const extraCount = sortedRenewals.length - topRenewals.length;

    // Build card data, retrying ENS metadata for cards missing an image (mirrors the
    // registration image-recovery flow). Done sequentially per card so we can update
    // imageData[i].nftImageUrl without a race; metadata API failures are non-fatal.
    const topNames: RenewalNameCard[] = [];
    for (const r of topRenewals) {
      let nftImageUrl = r.image;
      if (!nftImageUrl && r.tokenId && this.ensMetadataService) {
        try {
          logger.debug(`Renewal card image missing, retrying ENS metadata lookup for ${r.fullName}`);
          const metadata = await this.ensMetadataService.getMetadataWithFallback(r.tokenId);
          if (metadata?.image || metadata?.image_url) {
            nftImageUrl = metadata.image || metadata.image_url;
            logger.debug(`✅ Recovered renewal card image via ENS metadata: ${r.fullName}`);
          }
        } catch (error: any) {
          logger.debug(`ENS metadata retry failed for renewal card ${r.fullName}: ${error.message}`);
        }
      }
      topNames.push({
        ensName: this.cleanEnsName(r.fullName),
        costEth: parseFloat(r.costEth || '0'),
        nftImageUrl,
        contractAddress: r.contractAddress,
        tokenId: r.tokenId
      });
    }

    const renewerEns = this.getImageDisplayHandle(renewerAccount, renewerAddress);
    const renewerAvatar = renewerAccount?.avatar || renewerAccount?.records?.avatar;

    return {
      totalCostEth: totalEth,
      totalCostUsd: totalUsd,
      nameCount: sortedRenewals.length,
      topNames,
      extraCount,
      renewerEns,
      renewerAvatar,
      transactionHash: sample.transactionHash,
      timestamp: new Date()
    };
  }

  /**
   * Generate a complete tweet with text and image for a sale
   */
  async generateTweet(sale: ProcessedSale): Promise<GeneratedTweet> {
    try {
      logger.info(`Generating new format tweet for sale: ${sale.transactionHash}`);

      // Get full account data for buyer, seller, and fee recipient to access Twitter records
      const [buyerAccount, sellerAccount, feeRecipientAccount] = await Promise.all([
        this.getAccountData(sale.buyerAddress),
        this.getAccountData(sale.sellerAddress),
        sale.feeRecipientAddress ? this.getAccountData(sale.feeRecipientAddress) : Promise.resolve(null)
      ]);

      // Generate the tweet text
      const tweetText = await this.formatTweetText(sale, buyerAccount, sellerAccount, feeRecipientAccount);
      
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
   * Get historical context for sales and registrations.
   * Uses Grails API — lookup by ENS name directly (no contract/tokenId gymnastics).
   */
  private async getHistoricalContext(
    ensName: string,
    currentTxHash?: string
  ): Promise<string | null> {
    try {
      logger.info(`🔍 Fetching historical context for ${ensName} (Grails API)`);

      const ethPriceUsd = this.alchemyService ? await this.alchemyService.getETHPriceUSD() : undefined;
      const result = await GrailsApiService.getLastSaleOrMint(
        ensName,
        currentTxHash,
        0.01,
        ethPriceUsd ?? undefined
      );

      if (result) {
        logger.info(`✅ Found historical data: ${result.priceAmount} ${result.currencySymbol || 'ETH'}`);
        return TimeUtils.formatHistoricalEvent(Number(result.priceAmount), result.timestamp, result.type, result.currencySymbol);
      }

      logger.info(`ℹ️ No historical context found for ${ensName}`);
      return null;

    } catch (error: any) {
      logger.warn(`⚠️ Failed to fetch historical context for ${ensName}:`, error.message);
      return null;
    }
  }

  /**
   * Get current listing price context for bids.
   * Queries Grails (aggregator) for active listings across all marketplaces.
   * Shows source(s) in parentheses, e.g. "(Grails)" or "(Grails + OpenSea)"
   *
   * KNOWN LIMITATION: Listings are sorted by raw decimal price without
   * cross-currency normalization. If a single name has listings in both ETH
   * and a stablecoin (e.g. 0.5 ETH and 100 USDC), the comparison will be
   * arithmetically wrong (0.5 < 100 even though 0.5 ETH ≫ 100 USDC).
   * In practice ENS listings are virtually always ETH/WETH, so this rarely
   * surfaces. Fix path: convert candidates to ETH-equivalent via
   * `alchemyService.getETHPriceUSD()` before sorting.
   */
  private async getListingContext(
    contractAddress: string,
    tokenId: string,
    bidAmountEth: number,
    ensName?: string
  ): Promise<string | null> {
    logger.info(`🔍 Fetching listing context for ${contractAddress}:${tokenId}${ensName ? ` (${ensName})` : ''}`);

    if (!ensName) {
      logger.info('ℹ️ No ENS name available for listing lookup');
      return null;
    }

    const grailsResult = await GrailsApiService.getListingsForName(ensName).catch((err: any) => {
      logger.warn('⚠️ Grails listing lookup failed:', err.message);
      return [];
    });

    const SOURCE_DISPLAY: Record<string, string> = {
      grails: 'Grails',
      opensea: 'OpenSea',
      blur: 'Blur',
      x2y2: 'X2Y2',
      looksrare: 'LooksRare',
    };
    const displaySource = (raw: string): string => {
      const key = raw.toLowerCase();
      return SOURCE_DISPLAY[key] || raw;
    };

    type Candidate = { price: number; symbol: string; source: string };
    const candidates: Candidate[] = grailsResult.map(listing => ({
      price: listing.price,
      symbol: listing.currencySymbol,
      source: displaySource(listing.source || 'grails'),
    }));

    if (candidates.length === 0) {
      logger.info('ℹ️ No active listing found on any marketplace');
      return null;
    }

    candidates.sort((a, b) => a.price - b.price);
    const lowestPrice = candidates[0].price;

    const sourcesAtLowest = [
      ...new Set(
        candidates
          .filter((c) => c.price === lowestPrice)
          .map((c) => c.source)
      ),
    ].sort((a, b) => {
      if (a === 'Grails') return -1;
      if (b === 'Grails') return 1;
      return 0;
    });

    const displaySymbol = candidates[0].symbol === 'WETH' ? 'ETH' : candidates[0].symbol;
    const sourceTag = sourcesAtLowest.join(' + ');

    logger.info(`✅ Best listing: ${lowestPrice} ${displaySymbol} (${sourceTag}) — ${candidates.length} total across marketplaces`);
    return `List Price: ${lowestPrice.toFixed(2)} ${displaySymbol} (${sourceTag})`;
  }

  /**
   * Format the tweet text for ENS registrations
   */
  private async formatRegistrationTweetText(
    registration: ENSRegistration, 
    minterAccount: ENSWorkerAccount | null,
    minterAddress: string
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
        ensName,
        registration.transactionHash
      );
      if (historical) {
        historicalLine = historical;
      }
    } else {
      logger.warn(`⚠️ Missing required data for historical context: contractAddress=${registration.contractAddress}, tokenId=${registration.tokenId}`);
    }
    
    // Minter line (executor is the minter)
    const minterHandle = this.getDisplayHandle(minterAccount, minterAddress);
    const ownerLine = `Minter: ${minterHandle}`;
    
    // Category line (show category name with handle properly paired)
    const { clubs, clubRanks } = await this.clubService.getClubs(ensName);
    const formattedClubString = await this.clubService.getFormattedClubString(clubs, clubRanks);
    const categoryLabel = clubs.length > 1 ? 'Categories' : 'Category';
    const categoryLine = formattedClubString ? `${categoryLabel}: ${formattedClubString}` : '';
    
    // Grails marketplace link
    const marketplaceUrl = this.buildMarketplaceUrl(ensName);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n${ownerLine}`;
    if (historicalLine) {
      tweet += `\n\n${historicalLine}`;
    }
    if (categoryLine) {
      tweet += `\n${categoryLine}`;
    }
    if (marketplaceUrl) {
      tweet += `\n\n${marketplaceUrl}`;
    }
    
    return tweet;
  }

  /**
   * Format renewal tweet text in the structured format matching registrations.
   *
   * Single name:
   *   🔁 RENEWED: name.eth
   *   For: $X,XXX.XX (Y.YY ETH)
   *   Owner: name.eth @handle
   *   grails.app/name.eth
   *
   * Bulk (renewer = owner):
   *   🔁 RENEWED: 10 names
   *   For: $477.47 (0.21 ETH)
   *   Owner: name.eth @handle
   *   Top: name1.eth, name2.eth, name3.eth, +7 more
   *   Categories: Single Ethmoji @EthmojiClub
   *   grails.app/name1.eth
   *
   * Bulk (renewer ≠ owner — gift renewal):
   *   🔁 RENEWED: 10 names
   *   For: $477.47 (0.21 ETH)
   *   Owner: owner.eth @handle
   *   Renewer: renewer.eth @handle
   *   Top: ...
   */
  private async formatRenewalTweetText(
    sortedRenewals: ENSRenewal[],
    renewerAccount: ENSWorkerAccount | null,
    renewerAddress: string,
    totalEth: number,
    totalUsd: number
  ): Promise<string> {
    const nameCount = sortedRenewals.length;
    const top3 = sortedRenewals.slice(0, 3);
    const extra = nameCount - top3.length;

    // Header
    const topName = this.cleanEnsName(sortedRenewals[0].fullName);
    const header = nameCount === 1
      ? `🔁 RENEWED: ${topName}`
      : `🔁 RENEWED: ${nameCount} names`;

    // Price line (recalculate USD with fresh ETH rate, matching registration pattern)
    const priceEth = totalEth.toFixed(2);
    let priceUsdStr = '';
    if (totalUsd > 0) {
      priceUsdStr = `$${totalUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    const priceLine = priceUsdStr
      ? `For: ${priceUsdStr} (${priceEth} ETH)`
      : `For: ${priceEth} ETH`;

    // Owner line — resolve the owner of the top name (most expensive / representative)
    const topRow = sortedRenewals[0];
    const ownerAddress = topRow.ownerAddress;
    let ownerHandle: string;
    if (ownerAddress) {
      const ownerAccount = await this.getAccountData(ownerAddress);
      ownerHandle = this.getDisplayHandle(ownerAccount, ownerAddress);
    } else {
      // Owner lookup failed during ingestion — use renewer as fallback
      ownerHandle = this.getDisplayHandle(renewerAccount, renewerAddress);
    }
    const ownerLine = `Owner: ${ownerHandle}`;

    // Renewer line — only shown when renewer ≠ owner (gift renewal / 3rd-party service)
    let renewerLine = '';
    const isGiftRenewal = ownerAddress &&
      ownerAddress.toLowerCase() !== renewerAddress.toLowerCase();
    if (isGiftRenewal) {
      const renewerHandle = this.getDisplayHandle(renewerAccount, renewerAddress);
      renewerLine = `Renewer: ${renewerHandle}`;
    }

    // Top names line (bulk only)
    let topLine = '';
    if (nameCount > 1) {
      const topNames = top3.map(r => this.cleanEnsName(r.fullName)).join(', ');
      const extraSuffix = extra > 0 ? `, +${extra} more` : '';
      topLine = `${topNames}${extraSuffix}`;
    }

    // Category line — use the top name for club detection (matches image card ordering)
    const { clubs, clubRanks } = await this.clubService.getClubs(topName);
    const formattedClubString = await this.clubService.getFormattedClubString(clubs, clubRanks);
    const categoryLabel = clubs.length > 1 ? 'Categories' : 'Category';
    const categoryLine = formattedClubString ? `${categoryLabel}: ${formattedClubString}` : '';

    // Profile link — link to the renewer's Grails profile (not a single name,
    // since bulk renewals span many names and the actor is the interesting part)
    const marketplaceUrl = `grails.app/profile/${renewerAddress}`;

    // Assemble — matching the registration layout pattern
    let tweet = `${header}\n\n${priceLine}\n${ownerLine}`;
    if (renewerLine) {
      tweet += `\n${renewerLine}`;
    }
    if (topLine) {
      tweet += `\n\n${topLine}`;
    }
    if (categoryLine) {
      tweet += `\n\n${categoryLine}`;
    }
    if (marketplaceUrl) {
      tweet += `\n\n${marketplaceUrl}`;
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
    
    // If no ENS name from bid source, try to fetch it ourselves using OpenSea + ENS fallback
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
    const currencyDisplay = getCurrencyDisplayName(bid.currencySymbol);
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
        bidAmountEth,
        ensName
      );
      if (listing) {
        listingLine = listing;
      }
    }

    // Historical context line (NEW for bids)
    let historicalLine = '';
    if (bid.contractAddress && bid.tokenId) {
      const historical = await this.getHistoricalContext(ensName);
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
    
    // Category line (show category name with handle properly paired)
    const { clubs, clubRanks } = await this.clubService.getClubs(ensName);
    const formattedClubString = await this.clubService.getFormattedClubString(clubs, clubRanks);
    const categoryLabel = clubs.length > 1 ? 'Categories' : 'Category';
    const categoryLine = formattedClubString ? `${categoryLabel}: ${formattedClubString}` : '';
    
    // Marketplace link
    const marketplaceUrl = this.buildMarketplaceUrl(ensName);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n${bidderLine}\n\n${currentOwnerLine}`;
    if (listingLine) {
      tweet += `\n${listingLine}`;
    }
    if (historicalLine) {
      tweet += `\n${historicalLine}`;
    }
    if (categoryLine) {
      tweet += `\n${categoryLine}`;
    }
    if (marketplaceUrl) {
      tweet += `\n\n${marketplaceUrl}`;
    }
    
    return tweet;
  }



  /**
   * Format the tweet text according to the new specification
   */
  private async formatTweetText(
    sale: ProcessedSale, 
    buyerAccount: ENSWorkerAccount | null, 
    sellerAccount: ENSWorkerAccount | null,
    feeRecipientAccount?: ENSWorkerAccount | null
  ): Promise<string> {
    // Header: 💰 SOLD: name.eth
    const rawEnsName = sale.nftName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
    const header = `💰 SOLD: ${ensName}`;
    
    // Price line: For: $X (Y ETH/USDC) - 2 decimal places for USD in tweets
    const priceVal = parseFloat(sale.priceAmount).toFixed(2);
    const currency = sale.currencySymbol || 'ETH';
    const priceUsd = sale.priceUsd ? `$${parseFloat(sale.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    const priceLine = priceUsd ? `For: ${priceUsd} (${priceVal} ${currency})` : `For: ${priceVal} ${currency}`;
    
    // Historical context line (NEW)
    let historicalLine = '';
    if (sale.contractAddress && sale.tokenId) {
      const historical = await this.getHistoricalContext(
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
    
    // Category line (show category name with handle properly paired)
    logger.info(`[NewTweetFormatter] Getting club info for sale: ${ensName}`);
    const { clubs, clubRanks } = await this.clubService.getClubs(ensName);
    const formattedClubString = await this.clubService.getFormattedClubString(clubs, clubRanks);
    const categoryLabel = clubs.length > 1 ? 'Categories' : 'Category';
    const categoryLine = formattedClubString ? `${categoryLabel}: ${formattedClubString}` : '';
    logger.info(`[NewTweetFormatter] Sale category line result: "${categoryLine}"`);
    
    // Grails marketplace link
    const marketplaceUrl = this.buildMarketplaceUrl(ensName);
    
    // Combine all lines
    let tweet = `${header}\n\n${priceLine}\n${buyerLine}\n\n${sellerLine}`;
    
    // Add broker line if fee recipient present and not a known marketplace
    const brokerLine = this.formatBrokerLine(sale, feeRecipientAccount || null);
    if (brokerLine) {
      tweet += `\n${brokerLine}`;
    }
    
    if (historicalLine) {
      tweet += `\n${historicalLine}`;
    }
    if (categoryLine) {
      tweet += `\n${categoryLine}`;
    }
    if (marketplaceUrl) {
      tweet += `\n\n${marketplaceUrl}`;
    }
    
    return tweet;
  }

  /**
   * Get club mention for club slugs
   * Supports multiple clubs with comma separation
   */
  private getClubMention(clubs: string[]): string | null {
    return this.clubService.getClubMention(clubs);
  }

  /**
   * Get human-readable club name for club slugs
   * Supports multiple clubs with comma separation
   */
  private async getClubName(clubs: string[]): Promise<string | null> {
    return this.clubService.getClubName(clubs);
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
   * Build marketplace URL for an ENS name
   * Format: grails.app/name.eth
   * Encodes emoji and special characters for URL safety
   */
  private buildMarketplaceUrl(ensName: string): string {
    // Handle cases where ensName might be "Unknown ENS" or similar error states
    const cleanName = ensName.replace(/\.eth$/i, '').trim();
    if (!cleanName || 
        cleanName.toLowerCase() === 'unknown' || 
        cleanName.toLowerCase() === 'ens' ||
        cleanName.toLowerCase() === 'unknown ens') {
      return ''; // No link for problematic cases
    }
    
    // Ensure .eth suffix
    const fullEnsName = ensName.endsWith('.eth') ? ensName : `${ensName}.eth`;
    
    // URL-encode the name to handle emojis (especially keycap digits like 0⃣)
    // and other special characters that can break URLs
    const encodedName = encodeURIComponent(fullEnsName);
    
    return `grails.app/${encodedName}`;
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
      return `${ensName} @${cleanedTwitter}`;
    } else if (ensName) {
      return ensName;
    } else if (cleanedTwitter) {
      return `@${cleanedTwitter}`;
    }

    // Fallback to shortened address
    return this.shortenAddress(account.address || fallbackAddress);
  }

  /**
   * Format broker line for tweet display
   * Returns undefined if fee recipient is a marketplace or below threshold
   * Format: "Broker: name.eth @handle, X.XX% (Y.YY ETH)"
   */
  private formatBrokerLine(
    sale: ProcessedSale, 
    feeRecipientAccount: ENSWorkerAccount | null
  ): string | undefined {
    if (!sale.feeRecipientAddress) return undefined;
    
    const isMarketplace = isKnownMarketplaceFee(sale.feeRecipientAddress);
    const meetsThreshold = sale.feePercent && Number(sale.feePercent) >= 1; // 1% minimum
    
    if (isMarketplace || !meetsThreshold) return undefined;
    
    const brokerHandle = this.getDisplayHandle(feeRecipientAccount, sale.feeRecipientAddress);
    const feePercent = sale.feePercent ? `, ${Number(sale.feePercent).toFixed(2)}%` : '';
    
    return `Broker: ${brokerHandle}${feePercent}`;
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
  private async convertRegistrationToImageData(registration: ENSRegistration, minterAccount: ENSWorkerAccount | null, minterAddress: string): Promise<RealImageData> {
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
    
    // Get minter display info (ENS only for images)
    const minterHandle = this.getImageDisplayHandle(minterAccount, minterAddress);
    const minterAvatar = minterAccount?.avatar || minterAccount?.records?.avatar;
    
    const imageData: RealImageData = {
      priceEth,
      priceUsd,
      ensName,
      buyerEns: minterHandle, // Executor/minter is the "buyer"
      sellerEns: 'ENS DAO', // ENS DAO is the "seller"
      buyerAvatar: minterAvatar,
      sellerAvatar: undefined, // Will be handled by PuppeteerImageService with dao-profile.png
      nftImageUrl: registration.image, // Use ENS NFT image if available
      saleId: registration.id,
      transactionHash: registration.transactionHash,
      contractAddress: registration.contractAddress,
      tokenId: registration.tokenId
    };

    // If image was missing from ingestion, retry via ENS Metadata API using correct token IDs derived from the name
    if (!imageData.nftImageUrl && registration.tokenId && this.ensMetadataService) {
      try {
        logger.info(`🔄 Registration image missing, retrying ENS metadata lookup for ${ensName} (tokenId: ${registration.tokenId})`);
        const ensMetadata = await this.ensMetadataService.getMetadataWithFallback(registration.tokenId);
        if (ensMetadata?.image || ensMetadata?.image_url) {
          imageData.nftImageUrl = ensMetadata.image || ensMetadata.image_url;
          logger.info(`✅ Recovered registration image via ENS metadata retry: ${imageData.nftImageUrl?.substring(0, 80)}`);
        }
      } catch (error: any) {
        logger.warn(`⚠️ ENS metadata retry failed for registration image: ${error.message}`);
      }
    }

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
    
    const priceEth = parseFloat(bid.priceDecimal);
    const symbol = bid.currencySymbol?.toUpperCase();

    let priceUsd = 0;
    if (symbol === 'USDC' || symbol === 'USDT') {
      // Stablecoins: 1:1 USD
      priceUsd = priceEth;
      logger.debug(`💰 Stablecoin USD price: ${priceEth} ${symbol} = $${priceUsd.toFixed(2)}`);
    } else if (this.alchemyService && (symbol === 'ETH' || symbol === 'WETH')) {
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
    
    // If no ENS name from bid source, try to fetch it ourselves using OpenSea + ENS fallback
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
      tokenId: bid.tokenId,
      currencySymbol: bid.currencySymbol || 'ETH'
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
      timestamp: new Date(),
      contractAddress: sale.contractAddress,
      tokenId: sale.tokenId,
      currencySymbol: realData.currencySymbol
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
      tokenId: bid.tokenId,
      currencySymbol: realData.currencySymbol
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

    // Marketplace link is optional - only check if ENS name is valid (not "unknown" etc.)
    const ensName = content.match(/(\w+)\.eth/)?.[0] || '';
    const shouldHaveLink = ensName && 
                          !ensName.toLowerCase().includes('unknown') && 
                          ensName.toLowerCase() !== 'ens.eth';
    
    if (shouldHaveLink && !content.includes('grails.app')) {
      errors.push('Registration tweet should include marketplace link');
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


    // Marketplace link is optional - only check if ENS name is valid (not "unknown" etc.)
    const ensName = content.match(/(\w+)\.eth/)?.[0] || '';
    const shouldHaveLink = ensName && 
                          !ensName.toLowerCase().includes('unknown') && 
                          ensName.toLowerCase() !== 'ens.eth';
    
    if (shouldHaveLink && !content.includes('grails.app')) {
      errors.push('Bid tweet should include marketplace link');
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

    if (!content.includes('ETH') && !content.includes('USDC') && !content.includes('USDT') && !content.includes('DAI')) {
      errors.push('Tweet should include price with currency (ETH, USDC, USDT, or DAI)');
    }

    if (!content.includes('Seller:')) {
      errors.push('Tweet should include "Seller:" label');
    }

    if (!content.includes('Buyer:')) {
      errors.push('Tweet should include "Buyer:" label');
    }

    // Marketplace link is optional - only check if ENS name is valid (not "unknown" etc.)
    const ensName = content.match(/(\w+)\.eth/)?.[0] || '';
    const shouldHaveLink = ensName && 
                          !ensName.toLowerCase().includes('unknown') && 
                          ensName.toLowerCase() !== 'ens.eth';
    
    if (shouldHaveLink && !content.includes('grails.app')) {
      errors.push('Tweet should include marketplace link');
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
      brokerLine?: string;
      marketplaceUrl: string;
      buyerHandle: string;
      sellerHandle: string;
      brokerHandle?: string;
    };
  }> {
    const tweet = await this.generateTweet(sale);
    const validation = this.validateTweet(tweet.text);
    
    // Get account data for breakdown
    const [buyerAccount, sellerAccount, feeRecipientAccount] = await Promise.all([
      this.getAccountData(sale.buyerAddress),
      this.getAccountData(sale.sellerAddress),
      sale.feeRecipientAddress ? this.getAccountData(sale.feeRecipientAddress) : Promise.resolve(null)
    ]);

    const rawEnsName = sale.nftName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
    const priceVal = parseFloat(sale.priceAmount).toFixed(2);
    const currency = sale.currencySymbol || 'ETH';
    const priceUsd = sale.priceUsd ? `$${parseFloat(sale.priceUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
    const buyerHandle = this.getDisplayHandle(buyerAccount, sale.buyerAddress);
    const sellerHandle = this.getDisplayHandle(sellerAccount, sale.sellerAddress);
    
    // Broker line (only if valid fee recipient)
    const brokerLine = this.formatBrokerLine(sale, feeRecipientAccount);
    const brokerHandle = sale.feeRecipientAddress
      ? this.getDisplayHandle(feeRecipientAccount, sale.feeRecipientAddress)
      : undefined;
    
    // Check for club mention
    logger.info(`[NewTweetFormatter] Preview - Getting club info for: ${ensName}`);
    const { clubs, clubRanks } = await this.clubService.getClubs(ensName);
    const formattedClubString = await this.clubService.getFormattedClubString(clubs, clubRanks);
    const categoryLabel = clubs.length > 1 ? 'Categories' : 'Category';
    const categoryLine = formattedClubString ? `${categoryLabel}: ${formattedClubString}` : '';
    logger.info(`[NewTweetFormatter] Preview category line result: "${categoryLine}"`);
    
    const breakdown = {
      header: `💰 SOLD: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd} (${priceVal} ${currency})` : `For: ${priceVal} ${currency}`,
      buyerLine: `Buyer: ${buyerHandle}`,
      sellerLine: `Seller: ${sellerHandle}`,
      brokerLine,
      categoryLine: categoryLine,
      marketplaceUrl: this.buildMarketplaceUrl(ensName),
      buyerHandle: buyerHandle,
      sellerHandle: sellerHandle,
      brokerHandle
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
      marketplaceUrl: string;
      ownerHandle: string;
    };
  }> {
    const tweet = await this.generateRegistrationTweet(registration);
    const validation = this.validateRegistrationTweet(tweet.text);
    
    // Get account data for breakdown (minter = executor if available)
    const minterAddress = registration.executorAddress || registration.ownerAddress;
    const minterAccount = await this.getAccountData(minterAddress);

    const rawEnsName = registration.fullName || registration.ensName || 'Unknown ENS';
    const ensName = this.cleanEnsName(rawEnsName);
    const priceEth = parseFloat(registration.costEth || '0').toFixed(2);
    const priceUsd = registration.costUsd ? `($${parseFloat(registration.costUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : '';
    const minterHandle = this.getDisplayHandle(minterAccount, minterAddress);
    
    // Check for club mention
    const { clubs, clubRanks } = await this.clubService.getClubs(ensName);
    const formattedClubString = await this.clubService.getFormattedClubString(clubs, clubRanks);
    const categoryLabel = clubs.length > 1 ? 'Categories' : 'Category';
    const categoryLine = formattedClubString ? `${categoryLabel}: ${formattedClubString}` : '';
    
    const breakdown = {
      header: `🏛️ REGISTERED: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd.replace(/[()]/g, '')} (${priceEth} ETH)` : `For: ${priceEth} ETH`,
      ownerLine: `Minter: ${minterHandle}`,
      categoryLine: categoryLine,
      marketplaceUrl: this.buildMarketplaceUrl(ensName),
      ownerHandle: minterHandle
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
      marketplaceUrl: string;
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
    
    // If no ENS name from bid source, try to fetch it ourselves using OpenSea + ENS fallback
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
    const currencyDisplay = getCurrencyDisplayName(bid.currencySymbol);
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
    const duration = calculateBidDuration(bid.validFrom, bid.validUntil);
    const marketplaceUrl = this.buildMarketplaceUrl(ensName);
    
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
    const { clubs, clubRanks } = await this.clubService.getClubs(ensName);
    const formattedClubString = await this.clubService.getFormattedClubString(clubs, clubRanks);
    const categoryLabel = clubs.length > 1 ? 'Categories' : 'Category';
    const categoryLine = formattedClubString ? `${categoryLabel}: ${formattedClubString}` : '';
    
    const breakdown = {
      header: `✋ OFFER: ${ensName}`,
      ensName: ensName,
      priceLine: priceUsd ? `For: ${priceUsd} (${priceDecimal} ${currencyDisplay})` : `For: ${priceDecimal} ${currencyDisplay}`,
      validLine: `Valid: ${duration}`,
      bidderLine: `Bidder: ${bidderHandle}`,
      currentOwnerLine: `Owner: ${currentOwnerHandle}`,
      categoryLine: categoryLine,
      marketplaceUrl: marketplaceUrl,
      bidderHandle: bidderHandle,
      currentOwnerHandle: currentOwnerHandle
    };

    return { tweet, validation, breakdown };
  }

  /**
   * Validate renewal tweet content. Renewal text doesn't follow a strict fixed format
   * (the shape varies between single-name and bulk cases), so we only check for non-empty.
   */
  validateRenewalTweet(content: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    if (!content || content.trim().length === 0) {
      errors.push('Renewal tweet content cannot be empty');
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Preview renewal tweet with validation and breakdown — used by the dashboard
   * for manual generation/preview before posting.
   */
  async previewRenewalTweet(renewals: ENSRenewal[]): Promise<{
    tweet: GeneratedTweet;
    validation: { valid: boolean; errors: string[] };
    breakdown: {
      header: string;
      txHash: string;
      nameCount: number;
      totalEth: number;
      totalUsd: number;
      renewerHandle: string;
      topNames: Array<{ ensName: string; costEth: number }>;
      extraCount: number;
    };
  }> {
    const tweet = await this.generateRenewalTweet(renewals);
    const validation = this.validateRenewalTweet(tweet.text);

    if (renewals.length === 0) {
      return {
        tweet,
        validation,
        breakdown: {
          header: '🔁 RENEWED: (empty)',
          txHash: '',
          nameCount: 0,
          totalEth: 0,
          totalUsd: 0,
          renewerHandle: 'unknown',
          topNames: [],
          extraCount: 0
        }
      };
    }

    const sample = renewals[0];
    const sorted = [...renewals].sort((a, b) =>
      parseFloat(b.costEth || '0') - parseFloat(a.costEth || '0')
    );
    const totalEth = sorted.reduce((sum, r) => sum + parseFloat(r.costEth || '0'), 0);
    const totalUsd = sorted.reduce((sum, r) => sum + parseFloat(r.costUsd || '0'), 0);

    const renewerAccount = await this.getAccountData(sample.renewerAddress);
    const renewerHandle = this.getDisplayHandle(renewerAccount, sample.renewerAddress);

    const topNames = sorted.slice(0, 3).map(r => ({
      ensName: this.cleanEnsName(r.fullName),
      costEth: parseFloat(r.costEth || '0')
    }));

    const breakdown = {
      header: `🔁 RENEWED: ${renewals.length} name(s)`,
      txHash: sample.transactionHash,
      nameCount: renewals.length,
      totalEth,
      totalUsd,
      renewerHandle,
      topNames,
      extraCount: Math.max(0, renewals.length - topNames.length)
    };

    return { tweet, validation, breakdown };
  }
}
