/**
 * AIReplyService - Automated AI-powered contextual replies for ENS transactions
 * Phase 3.3: Generate and post AI replies as threaded responses to original tweets
 * 
 * This service orchestrates the full AI reply flow:
 * 1. Fetch transaction and validate prerequisites
 * 2. Parallel data fetching (Magic Eden, OpenSea, name research)
 * 3. Build LLM context
 * 4. Generate AI reply
 * 5. Post as threaded reply to Twitter
 * 6. Update database with result
 */

import { logger } from '../utils/logger';
import { IDatabaseService, ProcessedSale, ENSRegistration } from '../types';
import { OpenAIService } from './openaiService';
import { TwitterService } from './twitterService';
import { DataProcessingService } from './dataProcessingService';
import { MagicEdenV4Service, TokenActivity } from './magicEdenV4Service';
import { OpenSeaService } from './openSeaService';
import { ENSWorkerService } from './ensWorkerService';
import { APIToggleService } from './apiToggleService';

export class AIReplyService {
  private openaiService: OpenAIService;
  private databaseService: IDatabaseService;
  private twitterService: TwitterService;
  private dataProcessingService: DataProcessingService;
  private magicEdenV4Service: MagicEdenV4Service;
  private openSeaService: OpenSeaService;
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
    magicEdenV4Service: MagicEdenV4Service,
    openSeaService: OpenSeaService,
    ensWorkerService: ENSWorkerService
  ) {
    this.openaiService = openaiService;
    this.databaseService = databaseService;
    this.twitterService = twitterService;
    this.dataProcessingService = dataProcessingService;
    this.magicEdenV4Service = magicEdenV4Service;
    this.openSeaService = openSeaService;
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
    type: 'sale' | 'registration',
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
      const eventData = this.prepareEventData(type, transaction);

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

      // Step 4: Build LLM context
      logger.debug(`   [AI Reply] Step 4: Building LLM context...`);
      const llmContext = await this.dataProcessingService.buildLLMContext(
        eventData,
        contextData.tokenActivities,
        contextData.buyerActivities,
        contextData.sellerActivities,
        this.magicEdenV4Service,
        this.ensWorkerService,
        {
          tokenDataIncomplete: contextData.tokenDataIncomplete,
          buyerDataIncomplete: contextData.buyerDataIncomplete,
          sellerDataIncomplete: contextData.sellerDataIncomplete
        },
        {
          buyerHoldings: contextData.buyerHoldings,
          sellerHoldings: contextData.sellerHoldings
        }
      );

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
    type: 'sale' | 'registration',
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
    type: 'sale' | 'registration',
    recordId: number,
    requireAutoPostChecks: boolean = true
  ): Promise<{
    valid: boolean;
    reason?: string;
    transaction?: ProcessedSale | ENSRegistration;
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
      : await this.databaseService.getRegistrationById(recordId);

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
      : await this.databaseService.getAIReplyByRegistrationId(recordId);

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
  private prepareEventData(
    type: 'sale' | 'registration',
    transaction: ProcessedSale | ENSRegistration
  ): {
    type: 'sale' | 'registration';
    tokenName: string;
    price: number;
    priceUsd: number;
    currency: string;
    timestamp: number;
    buyerAddress: string;
    sellerAddress?: string;
    txHash: string;
  } {
    const isSale = type === 'sale';
    const sale = isSale ? transaction as ProcessedSale : null;
    const registration = !isSale ? transaction as ENSRegistration : null;

    const tokenName = isSale ? (sale!.nftName || 'Unknown') : registration!.fullName;

    return {
      type,
      tokenName,
      price: parseFloat(isSale ? sale!.priceEth : (registration!.costEth || '0')),
      priceUsd: parseFloat(isSale ? (sale!.priceUsd || '0') : (registration!.costUsd || '0')),
      currency: 'ETH',
      timestamp: new Date(transaction.blockTimestamp).getTime() / 1000,
      buyerAddress: isSale ? sale!.buyerAddress : registration!.ownerAddress,
      sellerAddress: isSale ? sale!.sellerAddress : undefined,
      txHash: transaction.transactionHash
    };
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
   * Helper: Fetch all context data in parallel (Magic Eden, OpenSea, name research)
   */
  private async fetchContextData(
    transaction: ProcessedSale | ENSRegistration,
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
  }> {
    logger.debug('      Parallel fetching: Token activity, Buyer activity, Seller activity, Holdings, Name research...');

    // Execute all API calls in parallel
    const [tokenResult, buyerResult, sellerResult, buyerHoldings, sellerHoldings, nameResearch] = await Promise.all([
      // Token activity history (V4 API)
      this.magicEdenV4Service.getTokenActivityHistory(
        transaction.contractAddress,
        transaction.tokenId,
        { limit: 10, maxPages: 120 } // 2x V3 pages to compensate for lower limit (120x10 = 1200 items)
      ).then(result => ({
        activities: this.magicEdenV4Service.transformV4ToV3Activities(result.activities),
        incomplete: result.incomplete,
        pagesFetched: result.pagesFetched
      })).catch((error: any) => {
        logger.error('      Token activity fetch failed:', error.message);
        return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0 };
      }),
      
      // Buyer activity history (V4 API)
      this.magicEdenV4Service.getUserActivityHistory(
        eventData.buyerAddress,
        { types: ['TRADE', 'MINT', 'TRANSFER'], maxPages: 60 }
      ).then(result => ({
        activities: this.magicEdenV4Service.transformV4ToV3Activities(result.activities),
        incomplete: result.incomplete,
        pagesFetched: result.pagesFetched
      })).catch((error: any) => {
        logger.error('      Buyer activity fetch failed:', error.message);
        return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0 };
      }),
      
      // Seller activity history (if applicable) (V4 API)
      eventData.sellerAddress
        ? this.magicEdenV4Service.getUserActivityHistory(
            eventData.sellerAddress,
            { types: ['TRADE', 'MINT', 'TRANSFER'], maxPages: 60 }
          ).then(result => ({
            activities: this.magicEdenV4Service.transformV4ToV3Activities(result.activities),
            incomplete: result.incomplete,
            pagesFetched: result.pagesFetched
          })).catch((error: any) => {
            logger.error('      Seller activity fetch failed:', error.message);
            return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0 };
          })
        : Promise.resolve(null),
      
      // Buyer's current ENS holdings
      this.openSeaService.getENSHoldings(eventData.buyerAddress, { limit: 200, maxPages: 5 }).catch((error: any) => {
        logger.error('      Buyer holdings fetch failed:', error.message);
        return { names: [], incomplete: true, totalFetched: 0 };
      }),
      
      // Seller's current ENS holdings (if sale)
      eventData.sellerAddress
        ? this.openSeaService.getENSHoldings(eventData.sellerAddress, { limit: 200, maxPages: 5 }).catch((error: any) => {
            logger.error('      Seller holdings fetch failed:', error.message);
            return { names: [], incomplete: true, totalFetched: 0 };
          })
        : Promise.resolve(null),
      
      // Name research - check cache first, fetch if needed
      this.getOrFetchNameResearch(eventData.tokenName)
    ]);

    logger.debug(`      Data fetched: Token=${tokenResult.activities.length}, Buyer=${buyerResult.activities.length}, Seller=${sellerResult?.activities.length || 0}, Name research=${nameResearch ? 'Yes' : 'No'}`);

    return {
      tokenActivities: tokenResult.activities,
      buyerActivities: buyerResult.activities,
      sellerActivities: sellerResult?.activities || null,
      buyerHoldings: buyerHoldings || null,
      sellerHoldings: sellerHoldings || null,
      nameResearch,
      tokenDataIncomplete: tokenResult.incomplete || false,
      buyerDataIncomplete: buyerResult.incomplete || false,
      sellerDataIncomplete: sellerResult?.incomplete || false
    };
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
    type: 'sale' | 'registration',
    transactionId: number,
    transaction: ProcessedSale | ENSRegistration,
    replyTweetId: string,
    generatedReply: any,
    nameResearch?: string
  ): Promise<void> {
    // Get name research ID from database
    const tokenName = ('nftName' in transaction) ? transaction.nftName : ('ensName' in transaction ? transaction.ensName : null);
    // Normalize name to always include .eth suffix for consistency
    const normalizedName = tokenName && tokenName.toLowerCase().endsWith('.eth') ? tokenName : (tokenName ? `${tokenName}.eth` : null);
    const nameResearchRecord = normalizedName ? await this.databaseService.getNameResearch(normalizedName) : null;
    
    await this.databaseService.insertAIReply({
      saleId: type === 'sale' ? transactionId : undefined,
      registrationId: type === 'registration' ? transactionId : undefined,
      originalTweetId: transaction.tweetId!,
      replyTweetId: replyTweetId,
      transactionType: type,
      transactionHash: transaction.transactionHash,
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
    type: 'sale' | 'registration',
    transactionId: number,
    transaction: ProcessedSale | ENSRegistration,
    generatedReply: any,
    nameResearch?: string
  ): Promise<number> {
    // Get name research ID from database
    const tokenName = ('nftName' in transaction) ? transaction.nftName : ('ensName' in transaction ? transaction.ensName : null);
    // Normalize name to always include .eth suffix for consistency
    const normalizedName = tokenName && tokenName.toLowerCase().endsWith('.eth') ? tokenName : (tokenName ? `${tokenName}.eth` : null);
    const nameResearchRecord = normalizedName ? await this.databaseService.getNameResearch(normalizedName) : null;
    
    const replyId = await this.databaseService.insertAIReply({
      saleId: type === 'sale' ? transactionId : undefined,
      registrationId: type === 'registration' ? transactionId : undefined,
      originalTweetId: transaction.tweetId!,
      replyTweetId: undefined, // Not posted yet
      transactionType: type,
      transactionHash: transaction.transactionHash,
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

