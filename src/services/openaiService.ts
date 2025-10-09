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
  nameResearch?: string; // Research results about the name
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
 * Uses GPT-5-mini with web search capability to create insightful, natural-language replies
 * Automatically switches to thinking model for large inputs
 */
export class OpenAIService {
  private client: OpenAI;
  private readonly temperature = 0.7; // Balance creativity and consistency
  private readonly maxRetries = 2; // Retry up to 2 times (3 total attempts)
  private readonly baseRetryDelay = 1000; // 1 second base delay
  
  // Model configurations (token limits based on Oct 2025 OpenAI specs)
  private readonly models: { 
    search: ModelConfig;
    base: ModelConfig; 
    thinking: ModelConfig;
  } = {
    search: {
      name: 'gpt-5-mini',
      maxInputTokens: 128000, // Web search tool has 128k limit
      description: 'GPT-5-mini with web search for name research'
    },
    base: {
      name: 'gpt-5-mini',
      maxInputTokens: 128000, // GPT-5-mini context window
      description: 'Fast, efficient model for tweet generation'
    },
    thinking: {
      name: 'o1', // Thinking model with larger context window
      maxInputTokens: 200000, // O1 extended context window
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
    logger.info(`   Search model: ${this.models.search.name} (with web search)`);
    logger.info(`   Generation model: ${this.models.base.name} (max ${this.models.base.maxInputTokens.toLocaleString()} tokens)`);
    logger.info(`   Fallback model: ${this.models.thinking.name} (max ${this.models.thinking.maxInputTokens.toLocaleString()} tokens)`);
  }

  /**
   * Sleep for a specified duration
   * @param ms - Milliseconds to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Determine if an error is retryable
   * @param error - Error to check
   * @returns True if should retry, false otherwise
   */
  private isRetryableError(error: any): boolean {
    // Retry on rate limits and server errors
    if (error?.status === 429) return true; // Rate limit
    if (error?.status >= 500) return true; // Server errors
    if (error?.code === 'ECONNRESET') return true; // Connection reset
    if (error?.code === 'ETIMEDOUT') return true; // Timeout
    
    // Don't retry on client errors
    if (error?.status === 401) return false; // Invalid API key
    if (error?.status === 400) return false; // Bad request
    if (error?.status === 403) return false; // Forbidden
    
    // Retry on unknown errors
    return true;
  }

  /**
   * Execute a function with retry logic
   * @param fn - Async function to execute
   * @param context - Description for logging
   * @returns Result from function
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: any;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        lastError = error;
        
        // Check if we should retry
        const isRetryable = this.isRetryableError(error);
        const isLastAttempt = attempt === this.maxRetries;
        
        if (!isRetryable || isLastAttempt) {
          throw error; // Don't retry or no more retries left
        }
        
        // Calculate delay with exponential backoff
        const isRateLimit = error?.status === 429;
        const delay = isRateLimit 
          ? this.baseRetryDelay * Math.pow(2, attempt) * 2 // Longer delay for rate limits
          : this.baseRetryDelay * Math.pow(2, attempt);
        
        logger.warn(`${context} failed (attempt ${attempt + 1}/${this.maxRetries + 1}): ${error.message}`);
        logger.info(`   Retrying in ${delay}ms...`);
        
        await this.sleep(delay);
      }
    }
    
    throw lastError;
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
   * Research an ENS name using GPT-5-mini with web search
   * Uses a detailed domain research prompt to gather comprehensive information
   * 
   * @param tokenName - Full ENS name (e.g., "example.eth")
   * @returns Research summary about the name
   */
  async researchName(tokenName: string): Promise<string> {
    try {
      // Extract label (remove .eth suffix)
      const label = tokenName.replace(/\.eth$/i, '');
      
      logger.info(`🔍 Researching name: ${label}...`);
      
      // Build focused research prompt
      const researchPrompt = `Research the name "${label}" for ENS market context.

FOCUS AREAS:
1. Meaning & Context
   - What does ${label} mean? (dictionary definition, translations in major languages)
   - Is it a common word, brand name, person name, or acronym?
   - Any cultural or industry significance?

2. Name Popularity & Usage
   - If it's a person name, check forebears.io for usage statistics (how common is it globally?)
   - Search interest or trend relevance
   - Geographic distribution if it's a name

3. Market Interest
   - Is this name registered on major TLDs (.com, .io, .ai)?
   - Any notable sales of similar names? (check NameBio, DNJournal if available)
   - General market demand for this type of name

OUTPUT (keep brief, 200 words max):
- Key meaning/context in 1-2 sentences
- Usage statistics if it's a common name (forebears data)
- Market relevance (if notable)

IMPORTANT: Be honest. If there's nothing particularly interesting or significant about this name, just say so. Don't inflate its importance or make up significance that isn't there. A common generic word is fine to describe as such.

Research: ${label}`;

      // Call GPT-5 with web search (with retry logic)
      const response = await this.withRetry(
        async () => {
          return await this.client.responses.create({
            model: this.models.search.name,
            input: researchPrompt,
            tools: [{ type: "web_search" }],
          });
        },
        `Name research for "${label}"`
      );

      const research = response.output_text?.trim() || '';
      
      logger.info(`✅ Name research complete: ${research.length} characters`);
      logger.debug(`   Research preview: ${research.slice(0, 200)}...`);
      
      return research;

    } catch (error: any) {
      logger.error('❌ Name research error:', error.message);
      // Return empty string rather than failing - tweet can still be generated without research
      logger.warn('   Continuing without name research...');
      return '';
    }
  }

  /**
   * Select the appropriate model based on input token count
   * Automatically switches to thinking model for very large inputs
   * 
   * Typical token usage for our prompts:
   * - System prompt: ~430 tokens
   * - User prompt (base): ~286 tokens  
   * - Name research: ~500-2000 tokens
   * - Activity history (10 entries per user): ~860 tokens
   * - Total typical: ~2,000-4,000 tokens (well under limits)
   * 
   * @param estimatedTokens - Estimated input token count
   * @returns Selected model configuration
   */
  private selectModel(estimatedTokens: number): ModelConfig {
    if (estimatedTokens <= this.models.base.maxInputTokens) {
      return this.models.base;
    } else if (estimatedTokens <= this.models.thinking.maxInputTokens) {
      logger.warn(`⚠️  Input (${estimatedTokens.toLocaleString()} tokens) exceeds base model limit`);
      logger.info(`   Switching to ${this.models.thinking.name} for extended context`);
      return this.models.thinking;
    } else {
      logger.error(`❌ Input (${estimatedTokens.toLocaleString()} tokens) exceeds all model limits!`);
      throw new Error(`Input too large: ${estimatedTokens.toLocaleString()} tokens (max: ${this.models.thinking.maxInputTokens.toLocaleString()})`);
    }
  }

  /**
   * Generate a contextual reply tweet based on sale/registration data
   * TWO-STEP PROCESS:
   * 1. Research the name using GPT-5 with web search
   * 2. Generate tweet using GPT-5 with research + transaction context
   * 
   * @param context - Complete LLM prompt context with event, token, and user data
   * @param preComputedResearch - Optional pre-computed name research (to avoid duplicate API calls)
   * @returns Generated tweet text and metadata
   */
  async generateReply(context: LLMPromptContext, preComputedResearch?: string): Promise<GeneratedReply> {
    try {
      logger.info(`🎨 Generating AI reply for ${context.event.tokenName}...`);
      
      // Step 1: Research the name (use pre-computed if available, otherwise fetch)
      const nameResearch = preComputedResearch !== undefined 
        ? preComputedResearch 
        : await this.researchName(context.event.tokenName);
      
      // Step 2: Build prompts with research results
      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(context, nameResearch);
      const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

      logger.debug('System prompt length:', systemPrompt.length);
      logger.debug('User prompt length:', userPrompt.length);
      logger.debug('Name research length:', nameResearch.length);
      logger.debug('Total prompt length:', fullPrompt.length);

      // Estimate tokens and select appropriate model
      const estimatedTokens = this.estimateTokens(fullPrompt);
      const selectedModel = this.selectModel(estimatedTokens);
      
      logger.info(`   Estimated input: ${estimatedTokens.toLocaleString()} tokens`);
      logger.info(`   Selected model: ${selectedModel.name} (${selectedModel.description})`);

      // Call OpenAI Responses API (with retry logic)
      const response = await this.withRetry(
        async () => {
          return await this.client.responses.create({
            model: selectedModel.name,
            input: fullPrompt,
          });
        },
        `Tweet generation for "${context.event.tokenName}"`
      );

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
        nameResearch: nameResearch || undefined,
      };

      logger.info(`✅ Generated ${tweetText.length} char reply using ${result.totalTokens} tokens`);
      logger.debug(`   Input: ${result.promptTokens} | Output: ${result.completionTokens}`);

      return result;

    } catch (error: any) {
      logger.error('❌ OpenAI generation error:', error.message);
      
      // Enhance error messages (retry logic already applied)
      if (error?.status === 429) {
        throw new Error('OpenAI rate limit exceeded after retries. Please try again later.');
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
    return `You are a market analyst writing about ENS domain sales and registrations. Pick out what's interesting and explain it clearly.

YOUR TASK:
Look at all the data provided (name meaning, buyer/seller activity, transaction history) and decide what's actually interesting to market watchers. Don't just list everything. Tell the story that matters.

WRITING STYLE:
- Use simple, everyday words (not "consolidator" or "monetizing" unless it's the clearest word)
- Short sentences that are easy to read
- Professional but not stuffy
- No slang or casual phrases like "on a tear," "swing," "nabbed"
- You have 1000 characters max

FORMATTING:
- NEVER use dashes (—, –, or - at start of lines)
- Use periods and commas
- Write in short paragraphs

WHAT TO FOCUS ON:
1. **Name meaning & popularity**: 
   - Only explain if it's unusual or unclear. Skip obvious ones like "students" or "coffee."
   - If it's a common name, mention usage statistics (e.g., "Common surname, ~50k bearers globally")
   - Explain obscure names, non-English words, or technical terms

2. **Club membership**: If the name belongs to a club (e.g., "999 Club #1,234 @ENS999club"):
   - Mention it if it adds context (e.g., "This is #1,234 in the 999 Club")
   - If it's a special position (low number), highlight it

3. **Trading patterns**: Only mention if notable:
   - Someone buying lots of similar names (what kind?)
   - Quick flips or unusual timing
   - 🚩 Wash trading red flags (fresh wallets, round numbers, rapid flips)
   - Big profit or loss on this specific sale

4. **Market context**: Why does this transaction matter?
   - Is this name type trending?
   - Unusual price for this category?
   - Notable buyer or seller behavior?

CRITICAL RULES:
- Don't state obvious things (like "this is a registration not a sale" when type is already clear)
- Don't explain obvious name meanings
- Don't list stats just because you have them
- Don't repeat the price or name from the main tweet
- Skip legal/trademark topics unless it's a major red flag
- NEVER offer personal services or suggest you can help ("I can look up..." "let me know if...")
- NEVER ask questions to the reader
- You are an automated analysis bot, not a person offering services

GOOD EXAMPLE:
"Edward is one of the most common English names globally (forebears shows ~600k bearers). The buyer has been focused on traditional first names, picking up 6 premium ones over 2 months. No flips, just holding. The seller waited over 3 years and made 4x. Classic identity names are seeing renewed interest."

BAD EXAMPLES:
"This descriptive education label shows strong SEO potential. The acquirer powergrails.eth demonstrates consolidator behavior with 6 acquisitions."

"Common given name, nothing exotic. Note there are live trademark filings using the same word, so commercial uses could carry legal risk in some industries."`;
  }

  /**
   * Format the LLM prompt context into a structured prompt
   * 
   * @param context - Complete context with event, token insights, and user stats
   * @param nameResearch - Research results about the name (from separate web search)
   * @returns Formatted prompt string
   */
  private buildUserPrompt(context: LLMPromptContext, nameResearch?: string): string {
    const { event, tokenInsights, buyerStats, sellerStats, buyerActivityHistory, sellerActivityHistory, clubInfo } = context;

    // Format event details
    let prompt = `EVENT:\n`;
    prompt += `- Type: ${event.type}\n`;
    prompt += `- Name: ${event.tokenName}\n`;
    prompt += `- Price: ${event.price} ETH ($${event.priceUsd.toLocaleString()})\n`;
    prompt += `- Buyer: ${event.buyerEnsName || event.buyerAddress.slice(0, 10) + '...'}\n`;
    
    if (event.type === 'sale' && event.sellerAddress) {
      prompt += `- Seller: ${event.sellerEnsName || event.sellerAddress.slice(0, 10) + '...'}\n`;
    }
    
    // Include club membership if available
    if (clubInfo) {
      prompt += `- Club: ${clubInfo}\n`;
    }

    // Include name research if available
    if (nameResearch) {
      prompt += `\nNAME RESEARCH:\n${nameResearch}\n`;
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

    prompt += `\n---

YOUR TASK: Look at all this data and pick out what's ACTUALLY INTERESTING to market watchers. Not all of it matters.

Ask yourself:
- Is the name meaning worth explaining? (Skip if obvious like "students")
- Is there a notable pattern in how the buyer or seller trades?
- What's the story here that people should know?

Write a clear, simple reply (up to 1000 chars) that focuses on what matters. Use everyday words.

REMEMBER:
- Don't state obvious things (transaction type is already clear from main tweet)
- NEVER offer services, help, or ask questions ("I can..." "let me know...")
- You are an automated bot providing market analysis, not a person`;

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

    if (text.length > 1000) {
      logger.warn(`Response too long: ${text.length} characters (max 1000 for Twitter Premium)`);
      return false;
    }

    return true;
  }
}

