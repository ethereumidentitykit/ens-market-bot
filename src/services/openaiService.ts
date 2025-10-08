import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { LLMPromptContext } from './dataProcessingService';

/**
 * Response from OpenAI containing generated tweet and metadata
 */
export interface GeneratedReply {
  tweetText: string;
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Model configuration with token limits
 */
interface ModelConfig {
  name: string;
  maxInputTokens: number;
  description: string;
}

/**
 * OpenAI Service for generating contextual tweet replies
 * Uses GPT-5 with web search capability to create insightful, natural-language replies
 * Automatically switches to thinking model for large inputs
 */
export class OpenAIService {
  private client: OpenAI;
  private readonly temperature = 0.7; // Balance creativity and consistency
  
  // Model configurations (token limits based on Oct 2025 OpenAI specs)
  // NOTE: Web search tool has a 128k token limit regardless of model
  private readonly WEB_SEARCH_TOKEN_LIMIT = 128000;
  
  private readonly models: { base: ModelConfig; thinking: ModelConfig } = {
    base: {
      name: 'gpt-5',
      maxInputTokens: 128000, // GPT-5 context window (matches web search limit)
      description: 'Fast, general-purpose model with web search'
    },
    thinking: {
      name: 'o1', // Thinking model with larger context window
      maxInputTokens: 200000, // O1 extended context window (but web search capped at 128k)
      description: 'Advanced reasoning model for complex/long inputs'
    }
  };

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY environment variable is required');
    }

    this.client = new OpenAI({
      apiKey: apiKey,
    });

    logger.info('🤖 OpenAIService initialized');
    logger.info(`   Base model: ${this.models.base.name} (max ${this.models.base.maxInputTokens.toLocaleString()} tokens)`);
    logger.info(`   Fallback model: ${this.models.thinking.name} (max ${this.models.thinking.maxInputTokens.toLocaleString()} tokens)`);
  }

  /**
   * Estimate token count for a string
   * Uses rough approximation: ~4 characters per token for English text
   * This is a conservative estimate to avoid exceeding limits
   * 
   * @param text - Text to estimate
   * @returns Estimated token count
   */
  private estimateTokens(text: string): number {
    // Conservative estimate: 3.5 chars per token (accounts for special tokens, whitespace)
    return Math.ceil(text.length / 3.5);
  }

  /**
   * Select the appropriate model based on input token count
   * NOTE: Web search tool has a 128k token limit regardless of model
   * 
   * Typical token usage for our prompts:
   * - System prompt: ~430 tokens
   * - User prompt (base): ~286 tokens  
   * - Activity history (10 entries per user): ~860 tokens
   * - Total typical: ~1,500 tokens (well under 128k limit)
   * 
   * The 128k limit would only be hit if we tried to include thousands of
   * activity entries, which is not expected in normal operation.
   * 
   * @param estimatedTokens - Estimated input token count
   * @returns Selected model configuration
   */
  private selectModel(estimatedTokens: number): ModelConfig {
    // Check web search token limit first (applies to all models)
    if (estimatedTokens > this.WEB_SEARCH_TOKEN_LIMIT) {
      logger.error(`❌ Input (${estimatedTokens.toLocaleString()} tokens) exceeds web search limit (${this.WEB_SEARCH_TOKEN_LIMIT.toLocaleString()} tokens)`);
      logger.error(`   Web search is required for name research but is capped at 128k tokens`);
      throw new Error(`Input too large for web search: ${estimatedTokens.toLocaleString()} tokens (max with web search: ${this.WEB_SEARCH_TOKEN_LIMIT.toLocaleString()})`);
    }
    
    // Select model based on input size (within web search limit)
    if (estimatedTokens <= this.models.base.maxInputTokens) {
      return this.models.base;
    } else {
      // This shouldn't happen since web search limit = base model limit, but keeping for safety
      logger.warn(`⚠️  Input (${estimatedTokens.toLocaleString()} tokens) exceeds base model limit`);
      logger.info(`   Switching to ${this.models.thinking.name} (but still limited by web search to 128k)`);
      return this.models.thinking;
    }
  }

  /**
   * Generate a contextual reply tweet based on sale/registration data
   * Automatically selects appropriate model based on input size
   * 
   * @param context - Complete LLM prompt context with event, token, and user data
   * @returns Generated tweet text and metadata
   */
  async generateReply(context: LLMPromptContext): Promise<GeneratedReply> {
    try {
      logger.info(`🎨 Generating AI reply for ${context.event.tokenName}...`);
      
      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(context);
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      logger.debug('System prompt length:', systemPrompt.length);
      logger.debug('User prompt length:', userPrompt.length);
      logger.debug('Total prompt length:', fullPrompt.length);

      // Estimate tokens and select appropriate model
      const estimatedTokens = this.estimateTokens(fullPrompt);
      const selectedModel = this.selectModel(estimatedTokens);
      
      logger.info(`   Estimated input: ${estimatedTokens.toLocaleString()} tokens`);
      logger.info(`   Selected model: ${selectedModel.name} (${selectedModel.description})`);

      // Call OpenAI Responses API with web search enabled
      const response = await this.client.responses.create({
        model: selectedModel.name,
        input: fullPrompt,
        tools: [{ type: "web_search" }], // Enable web search for name research
      });

      const tweetText = response.output_text?.trim() || '';
      
      // Validate response
      if (!this.validateResponse(tweetText)) {
        throw new Error(`Invalid response: ${tweetText.length} characters (max 280)`);
      }

      const usage = response.usage;
      const result: GeneratedReply = {
        tweetText,
        modelUsed: response.model,
        promptTokens: usage?.input_tokens || 0,
        completionTokens: usage?.output_tokens || 0,
        totalTokens: (usage?.input_tokens || 0) + (usage?.output_tokens || 0),
      };

      logger.info(`✅ Generated ${tweetText.length} char reply using ${result.totalTokens} tokens`);
      logger.debug(`   Input: ${result.promptTokens} | Output: ${result.completionTokens}`);

      return result;

    } catch (error: any) {
      logger.error('❌ OpenAI generation error:', error.message);
      
      // Handle rate limits
      if (error?.status === 429) {
        throw new Error('OpenAI rate limit exceeded. Please try again later.');
      }
      
      // Handle other API errors
      if (error?.status) {
        throw new Error(`OpenAI API error (${error.status}): ${error.message}`);
      }
      
      throw error;
    }
  }

  /**
   * Build system prompt with instructions for the AI
   * Defines the AI's role, tone, and constraints
   */
  private buildSystemPrompt(): string {
    return `You are an expert ENS (Ethereum Name Service) market analyst who provides insightful, conversational commentary on ENS name sales and registrations.

Your role is to write SHORT, engaging Twitter replies that add context and insight to ENS transactions.

GUIDELINES:
- Write in a natural, conversational tone (NOT robotic or structured)
- Focus on interesting patterns, context, and insights
- Highlight notable buyer/seller behavior, name significance, or market trends
- Use web search to research the name's meaning, cultural significance, or industry relevance
- Detect and call out suspicious patterns (wash trading, quick flips to fresh accounts)
- Keep it under 280 characters (Twitter limit)
- Do NOT repeat the sale price or name in the first line (already in main tweet)
- Be informative but engaging - make people want to read it

EXAMPLES OF GOOD REPLIES:
"The buyer has been quietly accumulating 3-letter domains, now at 47 total. This seller minted it 6 months ago for just 0.02 ETH."

"'Quantum' is gaining traction in tech circles - quantum computing companies are buying up related names. Smart pickup."

"🚩 This account has minted and flipped 15 names in the past month, always to fresh wallets. Classic wash trading pattern."

WHAT TO AVOID:
- Don't start with "X.eth just sold for Y ETH" (redundant)
- Don't be overly formal or robotic
- Don't just list data points without insight
- Don't ignore obvious patterns or red flags`;
  }

  /**
   * Format the LLM prompt context into a structured prompt
   * 
   * @param context - Complete context with event, token insights, and user stats
   * @returns Formatted prompt string
   */
  private buildUserPrompt(context: LLMPromptContext): string {
    const { event, tokenInsights, buyerStats, sellerStats, buyerActivityHistory, sellerActivityHistory } = context;

    // Format event details
    let prompt = `EVENT:\n`;
    prompt += `- Type: ${event.type}\n`;
    prompt += `- Name: ${event.tokenName}\n`;
    prompt += `- Price: ${event.price} ETH ($${event.priceUsd.toLocaleString()})\n`;
    prompt += `- Buyer: ${event.buyerEnsName || event.buyerAddress.slice(0, 10) + '...'}\n`;
    
    if (event.type === 'sale' && event.sellerAddress) {
      prompt += `- Seller: ${event.sellerEnsName || event.sellerAddress.slice(0, 10) + '...'}\n`;
    }

    // Format token insights
    prompt += `\nTOKEN HISTORY:\n`;
    if (tokenInsights.firstTx) {
      const daysAgo = Math.floor((Date.now() - tokenInsights.firstTx.timestamp * 1000) / (1000 * 60 * 60 * 24));
      prompt += `- First activity: ${tokenInsights.firstTx.type} ${daysAgo} days ago for ${tokenInsights.firstTx.price.toFixed(4)} ETH\n`;
    }
    if (tokenInsights.previousTx && tokenInsights.previousTx.timestamp !== tokenInsights.firstTx?.timestamp) {
      const daysAgo = Math.floor((Date.now() - tokenInsights.previousTx.timestamp * 1000) / (1000 * 60 * 60 * 24));
      prompt += `- Previous activity: ${tokenInsights.previousTx.type} ${daysAgo} days ago for ${tokenInsights.previousTx.price.toFixed(4)} ETH\n`;
    }
    prompt += `- Total volume: ${tokenInsights.totalVolume.toFixed(4)} ETH ($${tokenInsights.totalVolumeUsd.toLocaleString()}) across ${tokenInsights.numberOfSales} sales\n`;
    
    if (tokenInsights.sellerAcquisitionTracked && tokenInsights.sellerPnl !== null) {
      const profitSign = tokenInsights.sellerPnl >= 0 ? '+' : '';
      prompt += `- Seller ${tokenInsights.sellerAcquisitionType === 'mint' ? 'minted' : 'bought'} for ${tokenInsights.sellerBuyPrice?.toFixed(4)} ETH, PNL: ${profitSign}${tokenInsights.sellerPnl.toFixed(4)} ETH (${profitSign}$${tokenInsights.sellerPnlUsd?.toFixed(0)})\n`;
    }

    // Format buyer stats
    prompt += `\nBUYER STATS (${buyerStats.ensName || 'address ' + buyerStats.address.slice(0, 10) + '...'}):\n`;
    prompt += `- Buys: ${buyerStats.buysCount} (${buyerStats.buysVolume.toFixed(4)} ETH / $${buyerStats.buysVolumeUsd.toLocaleString()})\n`;
    prompt += `- Sells: ${buyerStats.sellsCount} (${buyerStats.sellsVolume.toFixed(4)} ETH / $${buyerStats.sellsVolumeUsd.toLocaleString()})\n`;
    prompt += `- Activity: ${buyerStats.transactionsPerMonth.toFixed(1)} txns/month\n`;
    if (buyerStats.topMarketplaces.length > 0) {
      prompt += `- Top markets: ${buyerStats.topMarketplaces.slice(0, 2).join(', ')}\n`;
    }

    // Format seller stats (if sale)
    if (sellerStats) {
      prompt += `\nSELLER STATS (${sellerStats.ensName || 'address ' + sellerStats.address.slice(0, 10) + '...'}):\n`;
      prompt += `- Buys: ${sellerStats.buysCount} (${sellerStats.buysVolume.toFixed(4)} ETH / $${sellerStats.buysVolumeUsd.toLocaleString()})\n`;
      prompt += `- Sells: ${sellerStats.sellsCount} (${sellerStats.sellsVolume.toFixed(4)} ETH / $${sellerStats.sellsVolumeUsd.toLocaleString()})\n`;
      prompt += `- Activity: ${sellerStats.transactionsPerMonth.toFixed(1)} txns/month\n`;
    }

    // Format buyer activity history (condensed for pattern detection)
    if (buyerActivityHistory.length > 0) {
      prompt += `\nBUYER FULL HISTORY (${Math.min(buyerActivityHistory.length, 10)} recent):\n`;
      const recentBuyerActivity = buyerActivityHistory.slice(-10); // Last 10
      for (const activity of recentBuyerActivity) {
        const date = new Date(activity.timestamp * 1000).toISOString().slice(0, 10);
        const tokenName = activity.tokenName ? activity.tokenName.slice(0, 20) : 'unknown';
        prompt += `- ${date}: ${activity.type} ${tokenName} for ${activity.price.toFixed(4)} ETH [${activity.role}]\n`;
      }
    }

    // Format seller activity history (condensed for pattern detection)
    if (sellerActivityHistory && sellerActivityHistory.length > 0) {
      prompt += `\nSELLER FULL HISTORY (${Math.min(sellerActivityHistory.length, 10)} recent):\n`;
      const recentSellerActivity = sellerActivityHistory.slice(-10); // Last 10
      for (const activity of recentSellerActivity) {
        const date = new Date(activity.timestamp * 1000).toISOString().slice(0, 10);
        const tokenName = activity.tokenName ? activity.tokenName.slice(0, 20) : 'unknown';
        prompt += `- ${date}: ${activity.type} ${tokenName} for ${activity.price.toFixed(4)} ETH [${activity.role}]\n`;
      }
    }

    prompt += `\nBased on this data, write a short, insightful Twitter reply (max 280 chars). Use web search to research the name "${event.tokenName}" if helpful. Focus on what's interesting or noteworthy about this transaction.`;

    return prompt;
  }

  /**
   * Validate that the generated response meets Twitter's requirements
   * 
   * @param text - Generated tweet text
   * @returns True if valid, false otherwise
   */
  private validateResponse(text: string): boolean {
    if (!text || text.length === 0) {
      logger.warn('Empty response from OpenAI');
      return false;
    }

    if (text.length > 280) {
      logger.warn(`Response too long: ${text.length} characters (max 280)`);
      return false;
    }

    return true;
  }
}

