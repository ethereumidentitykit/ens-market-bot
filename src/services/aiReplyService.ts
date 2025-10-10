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
import { MagicEdenService, TokenActivity } from './magicEdenService';
import { OpenSeaService } from './openSeaService';
import { ENSWorkerService } from './ensWorkerService';
import { APIToggleService } from './apiToggleService';

export class AIReplyService {
  private openaiService: OpenAIService;
  private databaseService: IDatabaseService;
  private twitterService: TwitterService;
  private dataProcessingService: DataProcessingService;
  private magicEdenService: MagicEdenService;
  private openSeaService: OpenSeaService;
  private ensWorkerService: ENSWorkerService;
  private apiToggleService: APIToggleService;

  // Timeout constants (in milliseconds)
  private readonly NAME_RESEARCH_TIMEOUT = 8 * 60 * 1000; // 8 minutes
  private readonly AI_GENERATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes

  constructor(
    openaiService: OpenAIService,
    databaseService: IDatabaseService,
    twitterService: TwitterService,
    dataProcessingService: DataProcessingService,
    magicEdenService: MagicEdenService,
    openSeaService: OpenSeaService,
    ensWorkerService: ENSWorkerService
  ) {
    this.openaiService = openaiService;
    this.databaseService = databaseService;
    this.twitterService = twitterService;
    this.dataProcessingService = dataProcessingService;
    this.magicEdenService = magicEdenService;
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
   * Core method: Generate and post AI reply for a sale or registration
   * Called by DatabaseEventService when a tweet is posted
   */
  async generateAndPostAIReply(
    type: 'sale' | 'registration',
    recordId: number
  ): Promise<void> {
    const startTime = Date.now();
    logger.info(`🤖 [AI Reply] Starting generation for ${type} ${recordId}`);

    try {
      // Step 1: Validate prerequisites
      logger.debug(`   [AI Reply] Step 1: Validating prerequisites...`);
      const validation = await this.validateReplyConditions(type, recordId);
      
      if (!validation.valid || !validation.transaction) {
        logger.warn(`   [AI Reply] ❌ Validation failed: ${validation.reason}`);
        return; // Skip this reply
      }

      const transaction = validation.transaction;
      const existingReply = validation.existingReply;

      // Step 2: Prepare event data
      logger.debug(`   [AI Reply] Step 2: Preparing event data...`);
      const eventData = this.prepareEventData(type, transaction);

      // Validate buyer ≠ seller (data error check)
      if (eventData.sellerAddress && 
          eventData.buyerAddress.toLowerCase() === eventData.sellerAddress.toLowerCase()) {
        logger.error(`   [AI Reply] ❌ Data error: buyer and seller are the same address!`);
        // Store error in database
        if (existingReply) {
          await this.updateReplyError(existingReply.id!, 'Data error: buyer and seller addresses are identical');
        }
        return;
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
        this.magicEdenService,
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

      // Step 6: Post threaded reply to Twitter
      logger.debug(`   [AI Reply] Step 6: Posting threaded reply to Twitter...`);
      const tweetResult = await this.twitterService.postReply(
        generatedReply.tweetText,
        transaction.tweetId!
      );

      if (!tweetResult.success || !tweetResult.tweetId) {
        throw new Error(`Failed to post reply: ${tweetResult.error}`);
      }

      logger.info(`   [AI Reply] ✅ Reply posted to Twitter - ID: ${tweetResult.tweetId}`);

      // Step 7: Update or insert database record
      logger.debug(`   [AI Reply] Step 7: Updating database...`);
      if (existingReply && existingReply.id) {
        // Update existing reply
        await this.updateReplyAsPosted(
          existingReply.id,
          tweetResult.tweetId,
          generatedReply,
          contextData.nameResearch
        );
      } else {
        // Insert new reply
        await this.insertNewReply(
          type,
          recordId,
          transaction,
          tweetResult.tweetId,
          generatedReply,
          contextData.nameResearch
        );
      }

      const totalTime = Date.now() - startTime;
      logger.info(`🎉 [AI Reply] ${type} ${recordId} complete in ${totalTime}ms - Tweet: ${tweetResult.tweetId}`);

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
   */
  private async validateReplyConditions(
    type: 'sale' | 'registration',
    recordId: number
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

    // Check if AI auto-posting is enabled
    if (!this.apiToggleService.isAIAutoPostingEnabled()) {
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
      // Token activity history
      this.magicEdenService.getTokenActivityHistory(
        transaction.contractAddress,
        transaction.tokenId
      ).catch((error: any) => {
        logger.error('      Token activity fetch failed:', error.message);
        return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0 };
      }),
      
      // Buyer activity history
      this.magicEdenService.getUserActivityHistory(
        eventData.buyerAddress
      ).catch((error: any) => {
        logger.error('      Buyer activity fetch failed:', error.message);
        return { activities: [] as TokenActivity[], incomplete: true, pagesFetched: 0 };
      }),
      
      // Seller activity history (if applicable)
      eventData.sellerAddress
        ? this.magicEdenService.getUserActivityHistory(eventData.sellerAddress).catch((error: any) => {
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
      
      // Name research with web search (8-minute timeout)
      (async () => {
        try {
          return await this.withTimeout(
            this.openaiService.researchName(eventData.tokenName),
            this.NAME_RESEARCH_TIMEOUT,
            'Name research'
          );
        } catch (error: any) {
          logger.error('      Name research failed, continuing without it:', error.message);
          return '';
        }
      })()
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
      nameResearch: nameResearch,
      status: 'posted',
      errorMessage: undefined
    });

    logger.debug(`      Inserted new reply record for ${type} ${transactionId}`);
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

