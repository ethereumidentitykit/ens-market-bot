/**
 * AIReplyService - Automated AI-powered contextual replies for ENS transactions
 * Phase 3.3: Generate and post AI replies as threaded responses to original tweets
 * 
 * This service orchestrates the full AI reply flow:
 * 1. Fetch transaction and validate prerequisites
 * 2. Parallel data fetching (Grails, OpenSea, name research)
 * 3. Build LLM context
 * 4. Generate AI reply
 * 5. Post as threaded reply to Twitter
 * 6. Update database with result
 */

import { logger } from '../utils/logger';
import { IDatabaseService, ProcessedSale, ENSRegistration, ENSBid } from '../types';
import { OpenAIService } from './openaiService';
import { TwitterService } from './twitterService';
import { DataProcessingService } from './dataProcessingService';
import { TokenActivity } from '../types/activity';
import { GrailsApiService } from './grailsApiService';
import { ENSWorkerService } from './ensWorkerService';
import { APIToggleService } from './apiToggleService';
import { AlchemyService } from './alchemyService';

export class AIReplyService {
  private openaiService: OpenAIService;
  private databaseService: IDatabaseService;
  private twitterService: TwitterService;
  private dataProcessingService: DataProcessingService;
  private alchemyService: AlchemyService;
  private ensWorkerService: ENSWorkerService;
  private apiToggleService: APIToggleService;

  // Timeout constants (in milliseconds)
  private readonly NAME_RESEARCH_TIMEOUT = 8 * 60 * 1000; // 8 minutes
  private readonly AI_GENERATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
  private readonly RESEARCH_MAX_AGE_DAYS = 30; // Research older than this is considered stale

  constructor(
    openaiService: OpenAIService,
    databaseService: IDatabaseService,
    twitterService: TwitterService,
    dataProcessingService: DataProcessingService,
    alchemyService: AlchemyService,
    ensWorkerService: ENSWorkerService
  ) {
    this.openaiService = openaiService;
    this.databaseService = databaseService;
    this.twitterService = twitterService;
    this.dataProcessingService = dataProcessingService;
    this.alchemyService = alchemyService;
    this.ensWorkerService = ensWorkerService;
    this.apiToggleService = APIToggleService.getInstance();
  }

  /**
   * Helper: Execute a promise with a timeout
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      )
    ]);
  }

  /**
   * Generate AI reply and store as 'pending' (does NOT post to Twitter)
   * Used by: Admin dashboard manual generation
   * @returns The ID of the generated reply
   */
  async generateReply(
    type: 'sale' | 'registration' | 'bid',
    recordId: number
  ): Promise<number> {
    const startTime = Date.now();
    logger.info(`🤖 [AI Reply] Starting generation for ${type} ${recordId}`);

    try {
      // Step 1: Validate prerequisites (skip auto-posting checks)
      logger.debug(`   [AI Reply] Step 1: Validating prerequisites...`);
      const validation = await this.validateReplyConditions(type, recordId, false); // skipAutoPostChecks
      
      if (!validation.valid || !validation.transaction) {
        throw new Error(`Validation failed: ${validation.reason}`);
      }

      const transaction = validation.transaction;
      const existingReply = validation.existingReply;

      // Step 2: Prepare event data
      logger.debug(`   [AI Reply] Step 2: Preparing event data...`);
      const eventData = await this.prepareEventData(type, transaction);

      // Validate buyer ≠ seller (data error check)
      if (eventData.sellerAddress && 
          eventData.buyerAddress.toLowerCase() === eventData.sellerAddress.toLowerCase()) {
        throw new Error('Data error: buyer and seller addresses are identical');
      }

      // Step 3: Fetch all context data in parallel
      logger.debug(`   [AI Reply] Step 3: Fetching context data in parallel...`);
      const contextData = await this.fetchContextData(
        transaction,
        eventData
      );

      // Step 3.5: Enrich activities with current ETH price (Grails API returns usd: 0)
      logger.debug(`   [AI Reply] Step 3.5: Enriching activities with ETH price...`);
      const ethPrice = await this.alchemyService.getETHPriceUSD();
      if (ethPrice) {
        this.enrichActivitiesWithUSD(contextData.tokenActivities, ethPrice);
        this.enrichActivitiesWithUSD(contextData.buyerActivities, ethPrice);
        if (contextData.sellerActivities) {
          this.enrichActivitiesWithUSD(contextData.sellerActivities, ethPrice);
        }
        if (contextData.recipientActivities) {
          this.enrichActivitiesWithUSD(contextData.recipientActivities, ethPrice);
        }
      }

      // Step 4: Build LLM context
      logger.debug(`   [AI Reply] Step 4: Building LLM context...`);
      const llmContext = await this.dataProcessingService.buildLLMContext(
        eventData,
        contextData.tokenActivities,
        contextData.buyerActivities,
        contextData.sellerActivities,
        this.ensWorkerService,
        {
          tokenDataIncomplete: contextData.tokenDataIncomplete,
          buyerDataIncomplete: contextData.buyerDataIncomplete,
          sellerDataIncomplete: contextData.sellerDataIncomplete,
          tokenDataUnavailable: contextData.tokenDataUnavailable,
          buyerDataUnavailable: contextData.buyerDataUnavailable,
          sellerDataUnavailable: contextData.sellerDataUnavailable,
          recipientDataIncomplete: contextData.recipientDataIncomplete,
          recipientDataUnavailable: contextData.recipientDataUnavailable
        },
        {
          buyerHoldings: contextData.buyerHoldings,
          sellerHoldings: contextData.sellerHoldings,
          recipientHoldings: contextData.recipientHoldings
        },
        contextData.recipientActivities
      );

      // Step 4.5: Enrich with portfolio data (wallet financial analysis)
      logger.debug(`   [AI Reply] Step 4.5: Enriching with portfolio data...`);
      try {
        // Enrich buyer stats with portfolio
        await this.dataProcessingService.enrichWithPortfolioData(
          llmContext.buyerStats,
          this.alchemyService
        );
        
        // Enrich seller stats with portfolio (if applicable)
        if (llmContext.sellerStats) {
          await this.dataProcessingService.enrichWithPortfolioData(
            llmContext.sellerStats,
            this.alchemyService
          );
        }

        // Enrich recipient stats with portfolio (if applicable)
        if (llmContext.recipientStats) {
          await this.dataProcessingService.enrichWithPortfolioData(
            llmContext.recipientStats,
            this.alchemyService
          );
        }
      } catch (error: any) {
        // Portfolio enrichment is optional - log error but continue
        logger.warn(`   Portfolio enrichment failed: ${error.message}`);
      }

      // Step 4.75: Attach active listings to context
      if (contextData.activeListings.length > 0) {
        llmContext.activeListings = contextData.activeListings;
        logger.debug(`   [AI Reply] Step 4.75: ${contextData.activeListings.length} active listing(s) attached`);
      }

      // Step 4.8: Attach previous replies for context
      llmContext.previousReplies = {
        recent: contextData.recentReplies,
        buyer: contextData.buyerPreviousReplies,
        seller: contextData.sellerPreviousReplies
      };
      logger.debug(`   [AI Reply] Step 4.8: Previous replies attached (recent=${contextData.recentReplies.length}, buyer=${contextData.buyerPreviousReplies.length}, seller=${contextData.sellerPreviousReplies.length})`);


      // Step 5: Generate AI reply (5-minute timeout)
      logger.debug(`   [AI Reply] Step 5: Generating AI reply with OpenAI...`);
      const generatedReply = await this.withTimeout(
        this.openaiService.generateReply(llmContext, contextData.nameResearch),
        this.AI_GENERATION_TIMEOUT,
        'AI reply generation'
      );

      // Step 6: Store in database as 'pending' (NOT posted)
      logger.debug(`   [AI Reply] Step 6: Storing reply as pending...`);
      const replyId = await this.insertNewReplyAsPending(
        type,
        recordId,
        transaction,
        generatedReply,
        contextData.nameResearch
      );

      const totalTime = Date.now() - startTime;
      logger.info(`✅ [AI Reply] ${type} ${recordId} generated in ${totalTime}ms - Reply ID: ${replyId} (pending)`);

      return replyId;

    } catch (error: any) {
      const totalTime = Date.now() - startTime;
      logger.error(`❌ [AI Reply] ${type} ${recordId} failed after ${totalTime}ms:`, error.message);
      logger.error(error.stack);
      throw error;
    }
  }

  /**
   * Post an existing pending AI reply to Twitter
   * Used by: Admin dashboard manual post button, or automatic post after generation
   * @param replyId The ID of the pending reply to post
   */
  async postReply(replyId: number): Promise<void> {
    const startTime = Date.now();
    logger.info(`📤 [AI Reply] Posting reply ${replyId} to Twitter...`);

    try {
      // Fetch the pending reply
      const reply = await this.databaseService.getAIReplyById(replyId);
      if (!reply) {
        throw new Error(`Reply ${replyId} not found in database`);
      }

      if (reply.status === 'posted' && reply.replyTweetId) {
        logger.info(`   Reply ${replyId} already posted - Tweet ID: ${reply.replyTweetId}`);
        return;
      }

      if (!reply.originalTweetId) {
        throw new Error(`Reply ${replyId} has no original tweet ID`);
      }

      // Post to Twitter
      const tweetResult = await this.twitterService.postReply(
        reply.replyText,
        reply.originalTweetId
      );

      if (!tweetResult.success || !tweetResult.tweetId) {
        throw new Error(`Failed to post reply: ${tweetResult.error}`);
      }

      logger.info(`   ✅ Reply posted to Twitter - ID: ${tweetResult.tweetId}`);

      // Update database to mark as posted
      await this.databaseService.pgPool.query(
        `UPDATE ai_replies 
         SET status = 'posted', reply_tweet_id = $1, error_message = NULL 
         WHERE id = $2`,
        [tweetResult.tweetId, replyId]
      );

      const totalTime = Date.now() - startTime;
      logger.info(`🎉 [AI Reply] Reply ${replyId} posted in ${totalTime}ms - Tweet: ${tweetResult.tweetId}`);

    } catch (error: any) {
      const totalTime = Date.now() - startTime;
      logger.error(`❌ [AI Reply] Reply ${replyId} post failed after ${totalTime}ms:`, error.message);
      
      // Record error in database
      try {
        await this.updateReplyError(replyId, error.message);
      } catch (dbError: any) {
        logger.error('   Failed to record error in database:', dbError.message);
      }

      throw error;
    }
  }

  /**
   * Generate and post AI reply (automatic flow)
   * Called by DatabaseEventService when a tweet is posted
   * This is a thin wrapper that calls generateReply() then postReply()
   */
  async generateAndPostAIReply(
    type: 'sale' | 'registration' | 'bid',
    recordId: number
  ): Promise<void> {
    const startTime = Date.now();
    logger.info(`🤖 [AI Reply] Starting automatic generation+post for ${type} ${recordId}`);

    try {
      // Validate auto-posting is enabled
      const validation = await this.validateReplyConditions(type, recordId, true); // requireAutoPostChecks
      
      if (!validation.valid || !validation.transaction) {
        logger.warn(`   [AI Reply] ❌ Validation failed: ${validation.reason}`);
        return; // Skip this reply
      }

      // Generate reply (stores as pending)
      const replyId = await this.generateReply(type, recordId);

      // Post to Twitter
      await this.postReply(replyId);

      const totalTime = Date.now() - startTime;
      logger.info(`🎉 [AI Reply] ${type} ${recordId} complete (auto-posted) in ${totalTime}ms`);

    } catch (error: any) {
      const totalTime = Date.now() - startTime;
      logger.error(`❌ [AI Reply] ${type} ${recordId} failed after ${totalTime}ms:`, error.message);
      logger.error(error.stack);
      
      // Try to record error in database
      try {
        const existingReply = type === 'sale'
          ? await this.databaseService.getAIReplyBySaleId(recordId)
          : await this.databaseService.getAIReplyByRegistrationId(recordId);
        
        if (existingReply && existingReply.id) {
          await this.updateReplyError(existingReply.id, error.message);
        }
      } catch (dbError: any) {
        logger.error('   [AI Reply] Failed to record error in database:', dbError.message);
      }

      throw error; // Re-throw for DatabaseEventService error handling
    }
  }

  /**
   * Helper: Validate that all prerequisites are met for generating a reply
   * @param requireAutoPostChecks If true, validates auto-posting is enabled (for automatic flow)
   */
  private async validateReplyConditions(
    type: 'sale' | 'registration' | 'bid',
    recordId: number,
    requireAutoPostChecks: boolean = true
  ): Promise<{
    valid: boolean;
    reason?: string;
    transaction?: ProcessedSale | ENSRegistration | ENSBid;
    existingReply?: any;
  }> {
    // Check if AI replies are enabled
    const aiEnabled = await this.databaseService.isAIRepliesEnabled();
    if (!aiEnabled) {
      return {
        valid: false,
        reason: 'AI replies are disabled in settings'
      };
    }

    // Check if OpenAI API is enabled
    if (!this.apiToggleService.isOpenAIEnabled()) {
      return {
        valid: false,
        reason: 'OpenAI API is disabled via admin toggle'
      };
    }

    // Check if AI auto-posting is enabled (only for automatic flow)
    if (requireAutoPostChecks && !this.apiToggleService.isAIAutoPostingEnabled()) {
      return {
        valid: false,
        reason: 'AI auto-posting is disabled via admin toggle'
      };
    }

    // Fetch transaction
    const transaction = type === 'sale'
      ? await this.databaseService.getSaleById(recordId)
      : type === 'registration'
      ? await this.databaseService.getRegistrationById(recordId)
      : await this.databaseService.getBidById(recordId);

    if (!transaction) {
      return {
        valid: false,
        reason: `${type} ${recordId} not found in database`
      };
    }

    // Check if transaction has been posted to Twitter
    if (!transaction.tweetId) {
      return {
        valid: false,
        reason: `${type} ${recordId} has not been posted to Twitter yet`
      };
    }

    // Check if reply already exists and is posted
    const existingReply = type === 'sale'
      ? await this.databaseService.getAIReplyBySaleId(recordId)
      : type === 'registration'
      ? await this.databaseService.getAIReplyByRegistrationId(recordId)
      : await this.databaseService.getAIReplyByBidId(recordId);

    if (existingReply && existingReply.status === 'posted' && existingReply.replyTweetId) {
      return {
        valid: false,
        reason: `Reply already posted (Tweet ID: ${existingReply.replyTweetId})`
      };
    }

    // All conditions met
    return {
      valid: true,
      transaction,
      existingReply
    };
  }

  /**
   * Helper: Prepare event data from transaction
   */
  private async prepareEventData(
    type: 'sale' | 'registration' | 'bid',
    transaction: ProcessedSale | ENSRegistration | ENSBid
  ): Promise<{
    type: 'sale' | 'registration' | 'bid';
    tokenName: string;
    price: number;
    priceUsd: number;
    currency: string;
    timestamp: number;
    buyerAddress: string;
    sellerAddress?: string;
    recipientAddress?: string;
    txHash?: string;
  }> {
    const isSale = type === 'sale';
    const isRegistration = type === 'registration';
    const isBid = type === 'bid';
    
    const sale = isSale ? transaction as ProcessedSale : null;
    const registration = isRegistration ? transaction as ENSRegistration : null;
    const bid = isBid ? transaction as ENSBid : null;

    const tokenName = isSale 
      ? (sale!.nftName || 'Unknown') 
      : isRegistration 
      ? registration!.fullName 
      : (bid!.ensName || 'Unknown');

    // For bids, resolve the current owner address
    let sellerAddress: string | undefined = undefined;
    if (isBid && bid) {
      sellerAddress = await this.getOwnerAddress(bid);
    } else if (isSale) {
      sellerAddress = sale!.sellerAddress;
    }

    return {
      type,
      tokenName,
      price: parseFloat(isSale ? sale!.priceAmount : isRegistration ? (registration!.costEth || '0') : bid!.priceDecimal),
      priceUsd: parseFloat(isSale ? (sale!.priceUsd || '0') : isRegistration ? (registration!.costUsd || '0') : (bid!.priceUsd || '0')),
      currency: isSale ? (sale!.currencySymbol || 'ETH') : isBid ? (bid!.currencySymbol || 'ETH') : 'ETH',
      timestamp: isBid 
        ? new Date(bid!.createdAtApi).getTime() / 1000 
        : new Date((sale || registration)!.blockTimestamp).getTime() / 1000,
      buyerAddress: isSale ? sale!.buyerAddress : isRegistration ? (registration!.executorAddress || registration!.ownerAddress) : bid!.makerAddress,
      sellerAddress,
      recipientAddress: isRegistration && registration!.executorAddress &&
        registration!.executorAddress.toLowerCase() !== registration!.ownerAddress.toLowerCase()
        ? registration!.ownerAddress
        : undefined,
      txHash: isBid ? undefined : (sale || registration)!.transactionHash
    };
  }

  /**
   * Helper: Get current owner address for a bid's token
   */
  private async getOwnerAddress(bid: ENSBid): Promise<string | undefined> {
    if (!bid.tokenId || !bid.contractAddress) {
      logger.warn(`Bid ${bid.id} missing tokenId or contractAddress for owner resolution`);
      return undefined;
    }
    
    try {
      logger.debug(`Resolving owner for token ${bid.tokenId} via Alchemy...`);
      const owners = await this.alchemyService.getOwnersForToken(
        bid.contractAddress,
        bid.tokenId
      );
      
      if (owners.length > 0) {
        logger.debug(`Found owner via Alchemy: ${owners[0]}`);
        return owners[0];
      }
      
      logger.warn(`No owner found for token ${bid.tokenId}`);
      return undefined;
    } catch (error: any) {
      logger.error(`Failed to resolve owner for bid ${bid.id}:`, error.message);
      return undefined;
    }
  }

  /**
   * Get or fetch name research with caching and staleness checking
   * @param ensName - The ENS name to research
   * @returns Research text or empty string on failure
   */
  private async getOrFetchNameResearch(ensName: string): Promise<string> {
    try {
      // Normalize name to always include .eth suffix for consistency
      const normalizedName = ensName.toLowerCase().endsWith('.eth') ? ensName : `${ensName}.eth`;
      
      // 1. Check if research exists in database
      const existingResearch = await this.databaseService.getNameResearch(normalizedName);
      
      if (existingResearch) {
        // 2. Check if research is fresh
        const researchAge = Date.now() - new Date(existingResearch.researchedAt).getTime();
        const ageInDays = researchAge / (1000 * 60 * 60 * 24);
        
        if (ageInDays < this.RESEARCH_MAX_AGE_DAYS) {
          logger.info(`♻️ Using cached research for ${normalizedName} (${ageInDays.toFixed(1)} days old)`);
          return existingResearch.researchText;
        } else {
          logger.info(`🔄 Research for ${normalizedName} is stale (${ageInDays.toFixed(1)} days), refreshing...`);
        }
      }
      
      // 3. Fetch new research with timeout
      logger.info(`🔍 Fetching new research for ${normalizedName}...`);
      const newResearch = await this.withTimeout(
        this.openaiService.researchName(ensName),
        this.NAME_RESEARCH_TIMEOUT,
        'Name research'
      );
      
      // 4. Store in database with normalized name
      if (newResearch) {
        await this.databaseService.insertNameResearch({
          ensName: normalizedName,
          researchText: newResearch,
          researchedAt: new Date().toISOString(),
          source: 'web_search'
        });
        logger.info(`💾 Stored new research for ${normalizedName}`);
      }
      
      return newResearch;
      
    } catch (error: any) {
      logger.error(`      Name research failed for ${ensName}:`, error.message);
      
      // 5. Fallback to stale research if available
      try {
        // Use normalized name for fallback lookup too
        const normalizedName = ensName.toLowerCase().endsWith('.eth') ? ensName : `${ensName}.eth`;
        const fallbackResearch = await this.databaseService.getNameResearch(normalizedName);
        if (fallbackResearch) {
          logger.warn(`⚠️ Using stale research for ${normalizedName} as fallback`);
          return fallbackResearch.researchText;
        }
      } catch (fallbackError: any) {
        logger.error(`      Fallback research fetch failed:`, fallbackError.message);
      }
      
      return ''; // Return empty if all attempts fail
    }
  }

  /**
   * Helper: Fetch all context data in parallel (Grails API, holdings, name research)
   */
  private async fetchContextData(
    transaction: ProcessedSale | ENSRegistration | ENSBid,
    eventData: any
  ): Promise<{
    tokenActivities: TokenActivity[];
    buyerActivities: TokenActivity[];
    sellerActivities: TokenActivity[] | null;
    buyerHoldings: any;
    sellerHoldings: any;
    nameResearch: string;
    tokenDataIncomplete: boolean;
    buyerDataIncomplete: boolean;
    sellerDataIncomplete: boolean;
    buyerDataUnavailable: boolean;
    sellerDataUnavailable: boolean;
    tokenDataUnavailable: boolean;
    recipientActivities: TokenActivity[] | null;
    recipientHoldings: any;
    recipientDataIncomplete: boolean;
    recipientDataUnavailable: boolean;
    activeListings: import('./grailsApiService').GrailsActiveListing[];
    recentReplies: import('../types').PreviousReply[];
    buyerPreviousReplies: import('../types').PreviousReply[];
    sellerPreviousReplies: import('../types').PreviousReply[];
  }> {
    logger.debug('      Parallel fetching: Token activity, Buyer activity, Seller activity, Holdings, Name research...');

    // Execute all API calls in parallel (Grails API — proxy-resolved, ENS-native data)
    const [tokenResult, buyerResult, sellerResult, buyerHoldings, sellerHoldings, nameResearch, recipientResult, recipientHoldings, activeListings, recentReplies, buyerPreviousReplies, sellerPreviousReplies] = await Promise.all([
      // Token activity history (Grails API — sales + mints by name)
      GrailsApiService.getNameActivity(
        eventData.tokenName,
        { limit: 50, maxPages: 10 }
      ).then(result => ({
        activities: result.activities,
        incomplete: result.incomplete,
        pagesFetched: result.pagesFetched,
        unavailable: false
      })).catch((error: any) => {
        logger.error('      Token activity fetch failed:', error.message);
        return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0, unavailable: true };
      }),

      // Buyer activity history (Grails API — sales + mints by address)
      GrailsApiService.getAddressActivity(
        eventData.buyerAddress,
        { limit: 50, maxPages: 50 }
      ).then(result => ({
        activities: result.activities,
        incomplete: result.incomplete,
        pagesFetched: result.pagesFetched,
        unavailable: false
      })).catch((error: any) => {
        logger.error('      Buyer activity fetch failed:', error.message);
        return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0, unavailable: true };
      }),

      // Seller activity history (Grails API — sales + mints by address)
      eventData.sellerAddress
        ? GrailsApiService.getAddressActivity(
            eventData.sellerAddress,
            { limit: 50, maxPages: 50 }
          ).then(result => ({
            activities: result.activities,
            incomplete: result.incomplete,
            pagesFetched: result.pagesFetched,
            unavailable: false
          })).catch((error: any) => {
            logger.error('      Seller activity fetch failed:', error.message);
            return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0, unavailable: true };
          })
        : Promise.resolve(null),
      
      // Buyer's current ENS holdings (Grails search API)
      GrailsApiService.getENSHoldings(eventData.buyerAddress, { limit: 50, maxPages: 20 }).catch((error: any) => {
        logger.error('      Buyer holdings fetch failed:', error.message);
        return { names: [], incomplete: true, totalFetched: 0 };
      }),
      
      // Seller's current ENS holdings (Grails search API)
      eventData.sellerAddress
        ? GrailsApiService.getENSHoldings(eventData.sellerAddress, { limit: 50, maxPages: 20 }).catch((error: any) => {
            logger.error('      Seller holdings fetch failed:', error.message);
            return { names: [], incomplete: true, totalFetched: 0 };
          })
        : Promise.resolve(null),
      
      // Name research - check cache first, fetch if needed
      this.getOrFetchNameResearch(eventData.tokenName),

      // Recipient activity history (only when executor ≠ owner)
      eventData.recipientAddress
        ? GrailsApiService.getAddressActivity(
            eventData.recipientAddress,
            { limit: 50, maxPages: 50 }
          ).then(result => ({
            activities: result.activities,
            incomplete: result.incomplete,
            pagesFetched: result.pagesFetched,
            unavailable: false
          })).catch((error: any) => {
            logger.error('      Recipient activity fetch failed:', error.message);
            return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0, unavailable: true };
          })
        : Promise.resolve(null),

      // Recipient's current ENS holdings (only when minter ≠ recipient)
      eventData.recipientAddress
        ? GrailsApiService.getENSHoldings(eventData.recipientAddress, { limit: 50, maxPages: 20 }).catch((error: any) => {
            logger.error('      Recipient holdings fetch failed:', error.message);
            return { names: [], incomplete: true, totalFetched: 0 };
          })
        : Promise.resolve(null),

      // Active listings for this name (bids only — shows bid vs ask spread)
      eventData.type === 'bid'
        ? GrailsApiService.getListingsForName(eventData.tokenName).catch((error: any) => {
            logger.warn('      Listing fetch failed:', error.message);
            return [];
          })
        : Promise.resolve([]),

      // Previous AI replies for context (avoid repetition)
      this.databaseService.getRecentPostedReplies(10),

      this.databaseService.getRepliesByAddress(eventData.buyerAddress, 5),

      eventData.sellerAddress
        ? this.databaseService.getRepliesByAddress(eventData.sellerAddress, 5)
        : Promise.resolve([])
    ]);

    logger.debug(`      Data fetched: Token=${tokenResult.activities.length}, Buyer=${buyerResult.activities.length}, Seller=${sellerResult?.activities.length || 0}, Recipient=${recipientResult?.activities.length || 0}, Name research=${nameResearch ? 'Yes' : 'No'}`);

    return {
      tokenActivities: tokenResult.activities,
      buyerActivities: buyerResult.activities,
      sellerActivities: sellerResult?.activities || null,
      buyerHoldings: buyerHoldings || null,
      sellerHoldings: sellerHoldings || null,
      nameResearch,
      tokenDataIncomplete: tokenResult.incomplete || false,
      buyerDataIncomplete: buyerResult.incomplete || false,
      sellerDataIncomplete: sellerResult?.incomplete || false,
      tokenDataUnavailable: tokenResult.unavailable || false,
      buyerDataUnavailable: buyerResult.unavailable || false,
      sellerDataUnavailable: sellerResult?.unavailable || false,
      recipientActivities: recipientResult?.activities || null,
      recipientHoldings: recipientHoldings || null,
      recipientDataIncomplete: recipientResult?.incomplete || false,
      recipientDataUnavailable: recipientResult?.unavailable || false,
      activeListings: activeListings || [],
      recentReplies: recentReplies || [],
      buyerPreviousReplies: buyerPreviousReplies || [],
      sellerPreviousReplies: sellerPreviousReplies || []
    };
  }

  /**
   * Enrich activities with USD and ETH-equivalent prices using the current ETH price.
   * Grails API returns usd: 0 for all activities and native: 0 for non-ETH currencies.
   *
   * Mutates the input array in place. Idempotent — already-set values are preserved.
   *
   * Pricing rules:
   * - ETH/WETH:        usd = native × ethPrice           (native already populated upstream)
   * - USDC/USDT/DAI:   usd = decimal (1:1)               and native = decimal / ethPrice
   *                                                      (so ETH-volume aggregations work)
   */
  private enrichActivitiesWithUSD(activities: TokenActivity[], ethPrice: number): void {
    for (const activity of activities) {
      const symbol = activity.price.currency.symbol?.toUpperCase();
      const isStablecoin = symbol === 'USDC' || symbol === 'USDT' || symbol === 'DAI';

      if (activity.price.amount.usd === 0) {
        if (isStablecoin && activity.price.amount.decimal > 0) {
          activity.price.amount.usd = activity.price.amount.decimal;
        } else if (activity.price.amount.native > 0) {
          activity.price.amount.usd = activity.price.amount.native * ethPrice;
        }
      }

      // Backfill ETH-equivalent for stablecoin activities so ETH-volume aggregations
      // (e.g. processBiddingStats.totalBidVolume) include them rather than treating
      // them as zero-ETH contributions.
      if (isStablecoin && activity.price.amount.native === 0 && ethPrice > 0 && activity.price.amount.decimal > 0) {
        activity.price.amount.native = activity.price.amount.decimal / ethPrice;
      }
    }
  }

  /**
   * Helper: Update existing reply record with posted status
   */
  private async updateReplyAsPosted(
    replyId: number,
    replyTweetId: string,
    generatedReply: any,
    nameResearch?: string
  ): Promise<void> {
    await this.databaseService.pgPool.query(`
      UPDATE ai_replies 
      SET 
        reply_tweet_id = $1,
        model_used = $2,
        prompt_tokens = $3,
        completion_tokens = $4,
        total_tokens = $5,
        reply_text = $6,
        name_research = $7,
        status = 'posted',
        posted_at = NOW(),
        error_message = NULL
      WHERE id = $8
    `, [
      replyTweetId,
      generatedReply.modelUsed,
      generatedReply.promptTokens,
      generatedReply.completionTokens,
      generatedReply.totalTokens,
      generatedReply.tweetText,
      nameResearch,
      replyId
    ]);

    logger.debug(`      Updated existing reply record (ID: ${replyId})`);
  }

  /**
   * Helper: Insert new reply record
   */
  private async insertNewReply(
    type: 'sale' | 'registration' | 'bid',
    transactionId: number,
    transaction: ProcessedSale | ENSRegistration | ENSBid,
    replyTweetId: string,
    generatedReply: any,
    nameResearch?: string
  ): Promise<void> {
    // Get name research ID from database
    const tokenName = ('nftName' in transaction) 
      ? transaction.nftName 
      : ('fullName' in transaction ? transaction.fullName : ('ensName' in transaction ? transaction.ensName : null));
    // Normalize name to always include .eth suffix for consistency
    const normalizedName = tokenName && tokenName.toLowerCase().endsWith('.eth') ? tokenName : (tokenName ? `${tokenName}.eth` : null);
    const nameResearchRecord = normalizedName ? await this.databaseService.getNameResearch(normalizedName) : null;
    
    await this.databaseService.insertAIReply({
      saleId: type === 'sale' ? transactionId : undefined,
      registrationId: type === 'registration' ? transactionId : undefined,
      bidId: type === 'bid' ? transactionId : undefined,
      originalTweetId: transaction.tweetId!,
      replyTweetId: replyTweetId,
      transactionType: type,
      transactionHash: 'transactionHash' in transaction ? transaction.transactionHash : undefined,
      modelUsed: generatedReply.modelUsed,
      promptTokens: generatedReply.promptTokens,
      completionTokens: generatedReply.completionTokens,
      totalTokens: generatedReply.totalTokens,
      costUsd: 0, // Not tracked per requirements
      replyText: generatedReply.tweetText,
      nameResearchId: nameResearchRecord?.id, // Link to research table
      nameResearch: nameResearch, // Keep for backward compatibility
      status: 'posted',
      errorMessage: undefined
    });

    logger.debug(`      Inserted new reply record for ${type} ${transactionId}`);
  }

  /**
   * Helper: Insert new reply record as 'pending' (NOT posted to Twitter yet)
   */
  private async insertNewReplyAsPending(
    type: 'sale' | 'registration' | 'bid',
    transactionId: number,
    transaction: ProcessedSale | ENSRegistration | ENSBid,
    generatedReply: any,
    nameResearch?: string
  ): Promise<number> {
    // Get name research ID from database
    const tokenName = ('nftName' in transaction) 
      ? transaction.nftName 
      : ('fullName' in transaction ? transaction.fullName : ('ensName' in transaction ? transaction.ensName : null));
    // Normalize name to always include .eth suffix for consistency
    const normalizedName = tokenName && tokenName.toLowerCase().endsWith('.eth') ? tokenName : (tokenName ? `${tokenName}.eth` : null);
    const nameResearchRecord = normalizedName ? await this.databaseService.getNameResearch(normalizedName) : null;
    
    const replyId = await this.databaseService.insertAIReply({
      saleId: type === 'sale' ? transactionId : undefined,
      registrationId: type === 'registration' ? transactionId : undefined,
      bidId: type === 'bid' ? transactionId : undefined,
      originalTweetId: transaction.tweetId!,
      replyTweetId: undefined, // Not posted yet
      transactionType: type,
      transactionHash: 'transactionHash' in transaction ? transaction.transactionHash : undefined,
      modelUsed: generatedReply.modelUsed,
      promptTokens: generatedReply.promptTokens,
      completionTokens: generatedReply.completionTokens,
      totalTokens: generatedReply.totalTokens,
      costUsd: 0, // Not tracked per requirements
      replyText: generatedReply.tweetText,
      nameResearchId: nameResearchRecord?.id, // Link to research table
      nameResearch: nameResearch, // Keep for backward compatibility
      status: 'pending', // NOT posted yet
      errorMessage: undefined
    });

    logger.debug(`      Inserted new pending reply record (ID: ${replyId}) for ${type} ${transactionId}`);
    return replyId;
  }

  /**
   * Helper: Update reply record with error
   */
  private async updateReplyError(replyId: number, errorMessage: string): Promise<void> {
    await this.databaseService.pgPool.query(`
      UPDATE ai_replies 
      SET 
        status = 'failed',
        error_message = $1
      WHERE id = $2
    `, [errorMessage, replyId]);

    logger.debug(`      Updated reply record ${replyId} with error`);
  }
}

