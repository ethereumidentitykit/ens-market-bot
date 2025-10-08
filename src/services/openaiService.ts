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
  private async researchName(tokenName: string): Promise<string> {
    try {
      // Extract label (remove .eth suffix)
      const label = tokenName.replace(/\.eth$/i, '');
      
      logger.info(`🔍 Researching name: ${label}...`);
      
      // Build comprehensive research prompt
      const researchPrompt = `ROLE
Act as a senior domain/name researcher and brand strategist. Your task is to evaluate the single-label name "${label}" (no TLD assumed) for meaning, significance, and potential value across web2 domains and web3 naming systems.

TOOLS
You MUST use web.run for every factual claim that isn't obvious. Prioritize authoritative sources. Include concise inline citations after the statements they support.

SCOPE
1) Semantics & usage
• Identify common meanings, translations, and connotations of ${label} across major languages and regions relevant to global use.
• Disambiguate entities sharing this label (companies, products, people, places). Note notoriety or newsworthiness.
• Check slang/NSFW/negative meanings.
• Assess acronym expansions if ${label} is 3–5 letters; rank by prevalence.

2) Brandability & linguistics
• Length, character class (letters/digits/hyphen), pronounceability (IPA approximation), syllable count, phonotactics, memorability, radio test.
• Confusables/homographs (IDN lookalikes), common misspellings, homophones.
• Globality: does it travel well across Latin/non-Latin markets?

3) Demand signals & SEO
• Keyword intent (navigational/informational/transactional).
• Trend direction and seasonality (high level if exact indices unavailable).
• SERP landscape snapshot: dominant categories/brands.
• If possible, approximate search interest and competitive density using reputable sources.

4) Market comparables & availability snapshot
• Recent public sales comps of exact/close variants (e.g., ${label}.com/.io/.ai; ${label}.eth; plural/singular; hyphenated). Prioritize NameBio, DNJournal, marketplace sold pages.
• Current availability/ask indications for major TLDs (.com/.net/.org/.io/.ai) and notable ccTLDs. If listed, capture indicative ask (not an appraisal).
• Check if the above TLDs are registered / non-registered for ${label}
• Social handle checks (read-only): note whether @${label} appears obviously taken on major platforms.
• ignore any .eth sales of this exact name.

5) Legal/reputation risk
• Trademark screening: exact-match and close variants in USPTO, EUIPO, WIPO Global Brand DB. Note Nice classes and status (LIVE/DEAD).
• Notable disputes, scandals, or sensitivities tied to the label or famous marks.

METHOD (use web.run)
• Run multiple search_query calls varying: "${label}", "${label} meaning", "${label} acronym", "${label} slang", "${label} brand", "${label} trademark", "${label} site:.gov|.edu", "${label} wiki", "${label}.com sale".
• When multilingual is relevant, query top languages where the string plausibly has meaning.
• Prefer primary/authoritative sources: Wikipedia/Wikidata, reputable dictionaries, news orgs, NameBio/DNJournal/marketplaces, USPTO/EUIPO/WIPO, major analytics sources.
• Cite 1–3 strongest sources per subsection. Do not over-cite.


OUTPUT
1) Executive summary (≤120 words)
2) Pros (bullets, 3–6 items).
3) Cons (bullets, 3–6 items).
4) Sales comps table (if any): {name | TLD/namespace | price | date | source}.
5) Snapshot table: {TLD | status | indicative ask (if any) | source}.
6) Risk notes (trademark/NSFW/controversy) with citations.


CONSTRAINTS
• Be concise and evidence-driven.
• If evidence is weak or conflicting, state uncertainty explicitly and why.

BEGIN with research for: ${label}`;

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
   * @returns Generated tweet text and metadata
   */
  async generateReply(context: LLMPromptContext): Promise<GeneratedReply> {
    try {
      logger.info(`🎨 Generating AI reply for ${context.event.tokenName}...`);
      
      // Step 1: Research the name (separate API call with web search)
      const nameResearch = await this.researchName(context.event.tokenName);
      
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
    return `You are an expert domain name market analyst who provides insightful, clear commentary on ENS domain transactions.

Your role is to write straightforward, informative replies that provide context about sales and registrations.

TONE & STYLE:
- Write in clear, professional language that's easy to understand
- Be direct and informative, NOT overly casual or slangy
- Avoid colloquialisms like "on a tear," "swing," "grabbed," etc.
- Use simple sentence structure for clarity
- Professional but engaging, like a knowledgeable analyst
- but dont be too formal or technical

FORMATTING RULES:
- NEVER use em dashes (—) or en dashes (–) 
- NEVER start lines with hyphens/dashes for bullet points
- Use periods and commas for natural flow
- Write in clear paragraphs with natural breaks

CONTENT GUIDELINES:
- You have up to 1000 characters (Twitter Premium limit)
- Do NOT repeat the sale price or name in the first line (already shown in the main tweet)
- Focus on: name significance, buyer/seller behavior, market context, timing
- Highlight interesting patterns (collecting behavior, flipping, wash trading, etc.)
- Use the name research to add cultural, linguistic, or industry context
- Include specific numbers when relevant (volume, PNL, collection size)
- Keep it straightforward and easy to understand

GOOD EXAMPLES:

"The buyer has acquired 47 names in 3 months, with a focus on Portuguese first names. This continues that pattern. The seller minted this 418 days ago for 0.69 ETH and held patiently. The exit at 4.8 ETH represents a 7x return, showing how patience can pay off with premium first names."

"João is equivalent to John in Portuguese-speaking countries and ranks among the most common names globally. International first names are gaining attention as ENS expands. This buyer focuses on culturally significant names across languages. The seller has been taking profits recently with 8 sales this month."

"🚩 This account minted 12 names in 3 weeks and immediately sold them all to fresh wallets with no history. The buyer account shows no prior activity and all prices are round numbers. This appears to be wash trading to create artificial market activity."

WHAT TO AVOID:
- Opening with "X.eth just sold for Y ETH" (already in main tweet)
- Casual slang or overly informal language
- Em dashes (—) and bullet point dashes
- Complex sentence structures that are hard to follow
- Generic observations without specific details`;
  }

  /**
   * Format the LLM prompt context into a structured prompt
   * 
   * @param context - Complete context with event, token insights, and user stats
   * @param nameResearch - Research results about the name (from separate web search)
   * @returns Formatted prompt string
   */
  private buildUserPrompt(context: LLMPromptContext, nameResearch?: string): string {
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

    prompt += `\nBased on all the data above (especially the name research), write an engaging Twitter reply that tells the story of this transaction. You have up to 1000 characters - use that space to provide real insight and context. What makes this transaction interesting or noteworthy? Connect the dots between the name, the participants, and the market context.`;

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

