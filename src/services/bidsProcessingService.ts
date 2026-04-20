import { IDatabaseService, BidProcessingStats } from '../types';
import { TransformedBid } from '../types/bids';
import { logger } from '../utils/logger';
import { isTokenIdHash, isSubdomain } from '../utils/nameUtils';
import { AlchemyService } from './alchemyService';
import { ClubService } from './clubService';
import { ensSubgraphService } from './ensSubgraphService';
import { GrailsApiService } from './grailsApiService';
import axios from 'axios';

// Re-export for backward compatibility with any external callers
export type { TransformedBid };

interface ENSMetadata {
  name: string;
  description: string;
  image: string;
  image_url: string;
  attributes: any[];
}

export class BidsProcessingService {
  private databaseService: IDatabaseService;
  private alchemyService: AlchemyService;
  private clubService: ClubService;

  constructor(
    databaseService: IDatabaseService,
    alchemyService: AlchemyService
  ) {
    this.databaseService = databaseService;
    this.alchemyService = alchemyService;
    this.clubService = new ClubService();

    logger.info('🔧 BidsProcessingService initialized (Grails-only)');
  }

  /**
   * Process pre-transformed bids from Grails API.
   * Handles deduplication, filtering, enrichment, and storage.
   */
  async processBids(bids: TransformedBid[]): Promise<BidProcessingStats> {
    const stats: BidProcessingStats = {
      newBids: 0,
      duplicates: 0,
      filtered: 0,
      errors: 0,
      processedCount: 0,
    };

    if (bids.length === 0) {
      logger.debug('No bids to process');
      return stats;
    }

    logger.info(`Processing ${bids.length} bids...`);

    for (const bid of bids) {
      try {
        await this.processSingleBid(bid, stats);
        stats.processedCount++;
      } catch (error: any) {
        logger.error(`❌ Failed to process bid ${bid.bidId}:`, error.message);
        stats.errors++;
      }
    }

    logger.info(`✅ Bids processing complete: ${stats.newBids} new, ${stats.duplicates} duplicates, ${stats.filtered} filtered, ${stats.errors} errors`);
    return stats;
  }

  private async processSingleBid(bid: TransformedBid, stats: BidProcessingStats): Promise<void> {
    try {
      const isProcessed = await this.databaseService.isBidProcessed(bid.bidId);
      if (isProcessed) {
        logger.debug(`⏭️  Bid ${bid.bidId} already processed, skipping`);
        stats.duplicates++;
        return;
      }

      if (!(await this.shouldProcessBid(bid))) {
        logger.debug(`🚫 Bid ${bid.bidId} filtered out (${bid.priceDecimal} ${bid.currencySymbol})`);
        stats.filtered++;
        return;
      }

      let enrichedBid = { ...bid };
      if (bid.tokenId) {
        try {
          enrichedBid = await this.enrichBidWithMetadata(bid);
        } catch (error: any) {
          logger.warn(`⚠️  Failed to enrich bid ${bid.bidId} with metadata:`, error.message);
        }
      }

      enrichedBid = await this.addUSDPricing(enrichedBid);

      if (enrichedBid.ensName) {
        const isBlacklisted = await this.databaseService.isNameBlacklisted(enrichedBid.ensName);
        if (isBlacklisted) {
          logger.info(`🚫 Skipping blacklisted name: ${enrichedBid.ensName}`);
          stats.filtered++;
          return;
        }

        if (isSubdomain(enrichedBid.ensName)) {
          logger.debug(`🚫 Skipping subdomain bid: ${enrichedBid.ensName}`);
          stats.filtered++;
          return;
        }
      }

      // Enrich with real Seaport order validity (startTime/endTime) by hitting
      // /offers/{id}. Only done after all filters pass to avoid wasted requests
      // on offers that won't be stored. Falls back to the synthetic 7-day default
      // baked into transformOffer() if the lookup fails.
      const offerIdMatch = bid.bidId.match(/^grails-(\d+)$/);
      if (offerIdMatch) {
        const validity = await GrailsApiService.getOfferValidity(offerIdMatch[1]);
        if (validity) {
          enrichedBid.validFrom = validity.validFrom;
          enrichedBid.validUntil = validity.validUntil;
          logger.debug(`📅 Enriched bid ${bid.bidId} with real validity: ${new Date(validity.validFrom * 1000).toISOString()} → ${new Date(validity.validUntil * 1000).toISOString()}`);
        } else {
          logger.debug(`📅 Bid ${bid.bidId} using fallback 7-day validity (Grails order lookup failed)`);
        }
      }

      const bidForStorage = {
        ...enrichedBid,
        tokenId: enrichedBid.tokenId || undefined,
        posted: false,
        tweetId: undefined,
        createdAt: undefined,
        updatedAt: undefined
      };

      const insertedId = await this.databaseService.insertBid(bidForStorage);
      logger.info(`✅ Stored bid ${bid.bidId} (ID: ${insertedId}) - ${enrichedBid.priceDecimal} ${enrichedBid.currencySymbol} for ${enrichedBid.ensName}`);

      stats.newBids++;

    } catch (error: any) {
      if (error.message?.includes('already processed')) {
        stats.duplicates++;
      } else {
        throw error;
      }
    }
  }

  /**
   * Enrich bid with ENS metadata (image, description).
   * Only calls ENS service if the source didn't provide name/image.
   */
  private async enrichBidWithMetadata(bid: any): Promise<any> {
    try {
      if (!bid.tokenId) {
        return bid;
      }

      const hasName = !!bid.ensName;
      const hasImage = !!bid.nftImage;

      logger.debug(`🔍 Bid metadata check - Name: ${hasName ? `"${bid.ensName}"` : 'missing'}, Image: ${hasImage ? 'provided' : 'missing'}`);

      if (hasName && hasImage) {
        return {
          ...bid,
          nftDescription: undefined,
        };
      }

      logger.debug(`🖼️  Fetching missing ENS metadata for token ID: ${bid.tokenId} (name: ${hasName ? '✓' : '✗'}, image: ${hasImage ? '✓' : '✗'})`);
      const metadataStartTime = Date.now();

      const ensContract = bid.contractAddress || '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
      const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;

      const response = await axios.get(metadataUrl, { timeout: 10000 });
      const metadata: ENSMetadata = response.data;

      const metadataTime = Date.now() - metadataStartTime;
      logger.debug(`✅ ENS metadata fetched in ${metadataTime}ms for: ${metadata.name}`);

      return {
        ...bid,
        ensName: bid.ensName || metadata.name,
        nftImage: bid.nftImage || metadata.image || metadata.image_url,
        nftDescription: metadata.description,
      };

    } catch (error: any) {
      logger.warn(`Failed to fetch ENS metadata for ${bid.tokenId}:`, error.message);
      return bid;
    }
  }

  private async addUSDPricing(bid: any): Promise<any> {
    try {
      const symbol = bid.currencySymbol?.toUpperCase();

      if (symbol === 'USDC' || symbol === 'USDT') {
        const priceUsd = parseFloat(bid.priceDecimal).toFixed(2);
        logger.debug(`💰 Stablecoin USD pricing: ${bid.priceDecimal} ${symbol} = $${priceUsd}`);
        return { ...bid, priceUsd };
      }

      if (symbol === 'ETH' || symbol === 'WETH') {
        const pricingStartTime = Date.now();
        const ethPriceUSD = await this.alchemyService.getETHPriceUSD();
        const pricingTime = Date.now() - pricingStartTime;

        if (ethPriceUSD) {
          const priceUsd = (parseFloat(bid.priceDecimal) * ethPriceUSD).toFixed(2);
          logger.debug(`💰 USD pricing added in ${pricingTime}ms: ${bid.priceDecimal} ETH = $${priceUsd}`);
          return { ...bid, priceUsd };
        }
      }

      return bid;
    } catch (error: any) {
      logger.warn(`Failed to add USD pricing for bid:`, error.message);
      return bid;
    }
  }

  /**
   * Filtering logic for bids.
   * Applies club-aware minimum thresholds and age limits.
   */
  private async shouldProcessBid(bid: TransformedBid): Promise<boolean> {
    try {
      if (!bid.tokenId || bid.tokenId === 'null') {
        logger.debug(`🚫 Skipping bid without token ID: ${bid.bidId || 'unknown'}`);
        return false;
      }

      if (bid.ensName) {
        const isBlacklisted = await this.databaseService.isNameBlacklisted(bid.ensName);
        if (isBlacklisted) {
          logger.debug(`🚫 Skipping blacklisted name: ${bid.ensName}`);
          return false;
        }
      }

      if (bid.ensName && isSubdomain(bid.ensName)) {
        logger.debug(`🚫 Skipping subdomain bid: ${bid.ensName}`);
        return false;
      }

      const bidAge = Date.now() - new Date(bid.createdAtApi).getTime();
      const maxAge = 24 * 60 * 60 * 1000;
      if (bidAge > maxAge) {
        logger.debug(`🚫 Skipping old bid: ${bid.bidId} (age: ${Math.round(bidAge / 1000 / 60)} minutes)`);
        return false;
      }

      const priceDecimal = parseFloat(bid.priceDecimal);
      const symbol = bid.currencySymbol?.toUpperCase();
      const ethMinimum = await this.getEthMinimumForBid(bid);
      const bidName = bid.ensName || bid.tokenId?.slice(-6) || 'unnamed';

      if (symbol === 'WETH' || symbol === 'ETH') {
        const passes = priceDecimal >= ethMinimum;
        logger.debug(`🔍 BID FILTER: ${bidName} - ${priceDecimal} ETH vs ${ethMinimum} ETH minimum = ${passes ? 'PASS ✅' : 'REJECT ❌'}`);
        return passes;
      }

      if (symbol === 'USDC' || symbol === 'USDT') {
        const ethPriceUSD = await this.alchemyService.getETHPriceUSD();
        if (!ethPriceUSD) {
          logger.warn(`⚠️ ETH price unavailable — allowing ${symbol} bid through (fail-open)`);
          return true;
        }
        const ethEquivalent = priceDecimal / ethPriceUSD;
        const passes = ethEquivalent >= ethMinimum;
        logger.debug(`🔍 BID FILTER: ${bidName} - ${priceDecimal} ${symbol} (~${ethEquivalent.toFixed(4)} ETH) vs ${ethMinimum} ETH minimum = ${passes ? 'PASS ✅' : 'REJECT ❌'}`);
        return passes;
      }

      logger.debug(`🚫 BID FILTER: ${bidName} - unknown currency ${symbol}, rejecting`);
      return false;

    } catch (error: any) {
      logger.error(`Error in bid filtering:`, error.message);
      return false;
    }
  }

  /**
   * Get ETH minimum requirement for a bid based on ENS name category.
   */
  private async getEthMinimumForBid(bid: any): Promise<number> {
    try {
      const defaultMin = await this.databaseService.getSystemState('autopost_bids_min_eth_default') || '2';
      const club10kMin = await this.databaseService.getSystemState('autopost_bids_min_eth_10k') || '5';
      const club999Min = await this.databaseService.getSystemState('autopost_bids_min_eth_999') || '20';

      logger.debug(`🔍 BID THRESHOLDS: Default=${defaultMin}, 10k=${club10kMin}, 999=${club999Min}`);

      const bidAmount = parseFloat(bid.priceDecimal);
      const lowestThreshold = Math.min(parseFloat(defaultMin), parseFloat(club10kMin), parseFloat(club999Min));

      if (bidAmount < lowestThreshold) {
        logger.debug(`⚡ EARLY REJECT: ${bidAmount} ETH < ${lowestThreshold} ETH (lowest threshold) - skipping name lookup`);
        return 999;
      }

      let ensName = bid.ensName || '';

      if (ensName && isTokenIdHash(ensName)) {
        logger.warn(`⚠️ Source provided token ID hash instead of name: "${ensName.substring(0, 30)}..." - fetching from ENS metadata`);
        ensName = '';
      }

      if (!ensName && bid.tokenId) {
        try {
          logger.debug(`🔍 Fetching ENS name for filtering: ${bid.tokenId}`);

          const subgraphStart = Date.now();
          ensName = await ensSubgraphService.getNameByTokenId(bid.tokenId, bid.contractAddress);
          const subgraphTime = Date.now() - subgraphStart;

          if (ensName) {
            logger.debug(`✅ ENS name resolved via subgraph in ${subgraphTime}ms: ${ensName}`);
          }

          if (!ensName) {
            logger.debug(`⚠️ Subgraph failed (${subgraphTime}ms), falling back to ENS metadata API`);

            const ensContract = bid.contractAddress || '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
            const metadataUrl = `https://metadata.ens.domains/mainnet/${ensContract}/${bid.tokenId}`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);

            try {
              const fetchStart = Date.now();
              const response = await fetch(metadataUrl, { signal: controller.signal });
              clearTimeout(timeoutId);
              const fetchTime = Date.now() - fetchStart;

              if (response.ok) {
                const metadata = await response.json();
                ensName = metadata.name || '';

                if (ensName && isTokenIdHash(ensName)) {
                  logger.error(`❌ ENS metadata also returned token ID hash: "${ensName.substring(0, 30)}..." - rejecting bid`);
                  return 999;
                }

                logger.debug(`✅ ENS name resolved via metadata API in ${fetchTime}ms: ${ensName}`);
              } else {
                logger.warn(`⚠️ ENS metadata API returned ${response.status} for ${ensContract}:${bid.tokenId} (${fetchTime}ms)`);
              }
            } finally {
              clearTimeout(timeoutId);
            }
          }
        } catch (error: any) {
          const errorMsg = error.name === 'AbortError' ? 'timeout after 3s' : error.message;
          logger.debug(`🚫 ENS name resolution failed (${errorMsg}), rejecting bid without proper name`);
          return 999;
        }
      }

      if (!ensName) {
        logger.debug(`🚫 No ENS name available, rejecting bid without proper name`);
        return 999;
      }

      const isBlacklisted = await this.databaseService.isNameBlacklisted(ensName);
      if (isBlacklisted) {
        logger.info(`🚫 BLACKLIST REJECT: ${ensName} is blacklisted - rejecting bid`);
        return 999;
      }

      const { clubs } = await this.clubService.getClubs(ensName);

      if (clubs.includes('999')) {
        logger.debug(`🎯 BID FILTER: ${ensName} - 999 Club detected, minimum: ${club999Min} ETH`);
        return parseFloat(club999Min);
      } else if (clubs.includes('10k')) {
        logger.debug(`🎯 BID FILTER: ${ensName} - 10k Club detected, minimum: ${club10kMin} ETH`);
        return parseFloat(club10kMin);
      }

      logger.debug(`🎯 BID FILTER: ${ensName} - default minimum: ${defaultMin} ETH`);
      return parseFloat(defaultMin);

    } catch (error: any) {
      logger.warn(`Error determining ETH minimum for bid:`, error.message);
      return 0.4;
    }
  }

}
