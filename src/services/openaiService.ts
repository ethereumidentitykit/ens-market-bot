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
   * Sanitize ENS label to prevent prompt injection
   * @param label - Raw ENS label (without .eth)
   * @returns Sanitized label safe for prompt interpolation
   */
  private sanitizeLabel(label: string): string {
    // Remove any potential prompt injection characters
    // Keep only alphanumeric, common punctuation, and emojis
    let sanitized = label
      .replace(/[`"'\\\n\r\t]/g, '') // Remove quotes, backticks, newlines, tabs
      .replace(/\{|\}/g, '') // Remove curly braces (markdown/formatting)
      .replace(/\[|\]/g, '') // Remove square brackets
      .trim();
    
    // Limit length to prevent prompt overflow (max 100 chars for ENS label)
    if (sanitized.length > 100) {
      sanitized = sanitized.substring(0, 100);
    }
    
    return sanitized;
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
      
      // Sanitize label to prevent prompt injection
      const sanitizedLabel = this.sanitizeLabel(label);
      
      logger.info(`🔍 Researching name: ${label}...`);
      
      // Build focused research prompt (using sanitized label)
      const researchPrompt = `Research the name "${sanitizedLabel}" for ENS market context.

FOCUS AREAS:
1. Meaning & Context
   - What does ${sanitizedLabel} mean? (dictionary definitions or common usages), etymology if uncommon or interesting.
   - Is it a common word, brand name, person name, or acronym?
   - Any cultural significance in gaming, crypto, or online communities?

2. Crypto/Web3 Connections (CHECK MARKET CAP!)
   - Is this name connected to any NOTABLE crypto projects, protocols, or products? (tokens, DeFi platforms, DAOs, NFT projects)
   - Recent announcements or launches in crypto/web3 space using this name? check articles etc.
   - Token tickers, protocol names, stablecoin names, or blockchain infrastructure
   - need to be very careful when mentioning tokens, there are a lot of scammy tokens out there with fake market caps. make sure to check carefully.
   - Web3 brands, wallets, or crypto infrastructure using this name?
   - **FOR TOKENS: CHECK COINGECKO OR COINMARKETCAP**
     - Look up the token's market cap and ranking
     - Only consider tokens with market cap ABOVE $5 million as notable
     - Tokens under $5M market cap (typically ranked 2000+ on CoinGecko) are too small to mention
     - Example: A token at $60k market cap, rank 8500 = NOT notable, skip it
   - Even obscure-looking names may have specific crypto meanings - check thoroughly

3. Name Popularity & Usage
   - If it's a person name, check forebears.io or other sources for usage statistics (how common is it globally?)
   - Search interest or trend relevance
   - Geographic distribution if it's a name

4. Username/Identity Value (focus here for ENS)
   - Would this work well as a username, gamertag, or online identity? (e.g., demon, killer, anon, legend, chad)
   - Is it short, memorable, and distinctive for personal branding?
   - Popular in gaming, crypto, or social communities?

IMPORTANT PERSPECTIVE:
- Multiple meanings or uses = GOOD (more potential buyers from different communities)
- Names that cross boundaries (e.g., person name + crypto term + gaming reference) = HIGH MARKET DEMAND
- "Search noise" or "ambiguity" are NOT negatives - they indicate cross-market appeal
- Think usernames, not web2 domains: versatility and multiple interpretations = valuable
- never ask questions, you are making a report. if you are uncertain about something, put that in your report.

SKIP:
- Legal/trademark/IP/copyright issues (not relevant for web3 usernames)
- "Commercial use" or brand protection concerns
- Corporate domain valuation frameworks
- SEO/branding "noise" concerns (these are web2 concepts, not relevant here)

Be honest. If there's nothing interesting or significant about this name, say so. Don't inflate its importance or significance. If it's a word or string without wide recognition - thats good info to return.

Research: ${sanitizedLabel}`;

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

      const rawText = response.output_text?.trim() || '';
      
      // Add title/header to the tweet
      const tweetText = `🤖 GrailsAI Insight (beta):\n\n${rawText}`;
      
      // Validate response (with title included)
      if (!this.validateResponse(tweetText)) {
        throw new Error(`Invalid response: ${tweetText.length} characters (max 1200)`);
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
    return `You are a market analyst writing about ENS domain sales, registrations, and bids. Pick out what's interesting and explain it clearly.

YOUR TASK:
Look at all the data provided (name meaning, buyer/seller/bidder/owner activity, transaction history) and decide what's actually interesting to market watchers. Don't just list everything. Tell the story that matters.
you can keep a couple numerical data points, but don't make it the main focus.

**FOR BIDS SPECIFICALLY**:
- The "buyer" is the bidder (person making the offer)
- The "seller" (if present) is the current owner of the name
- Focus on: Why this bid is interesting, the bidder's collecting patterns, whether the owner typically accepts offers or holds long-term
- Interesting angles: Strategic bidding (bidder's portfolio suggests they value this name), owner's selling behavior (do they flip or hold?), bid relative to recent sales

NOTE: Your response will be prefixed with "AI insight:" automatically, so don't include that in your text.

STRUCTURE (IMPORTANT):
Your response MUST have TWO parts:
1. **First paragraph (TL;DR)**: A concise 1-2 sentence summary of the most interesting insight
2. **Remaining paragraphs**: Detailed explanation and context

The TL;DR should capture the main story in 100-150 characters. Then expand with supporting details.

WRITING STYLE:
- Use simple, everyday words (not "consolidator" or "monetizing" unless it's the clearest word)
- Short sentences that are easy to read
- Professional but not stuffy
- No slang or casual phrases like "on a tear," "swing," "nabbed"
- You have 1200 characters max (TL;DR + details combined)

FORMATTING:
- NEVER use dashes (—, –, or - at start of lines)
- Use periods and commas
- Write in short paragraphs

WHAT TO FOCUS ON:
1. **Crypto/Web3 connections (HIGHEST PRIORITY)**:
   - If the name research found SIGNIFICANT crypto/web3 connections, mention them, especially if very recent news (within days)
   - Token tickers, protocol names, recent crypto announcements, DeFi platforms, stablecoins, etc.
   - This is often the MOST interesting insight for obscure-looking names
   - Example: If research finds it's a new stablecoin ticker or protocol name, lead with that
   - **TOKEN MARKET CAP THRESHOLD**: Only mention tokens with market cap ABOVE $5 million. Tokens under $5M (typically ranked 2000+ on CoinGecko) are NOT significant. Example: $60k market cap at rank 8500 = skip entirely
   - **IMPORTANT**: Only mention if it's a real, notable use case. Skip "small crypto ticker activity" or minor/obscure projects
   - **CRITICAL**: If the crypto connection isn't major/significant, don't mention crypto AT ALL. NEVER say "not tied to a major protocol", "not a major token", "though not associated with", etc. Either highlight a significant crypto use or skip crypto entirely

2. **Name meaning & popularity**: 
   - Only explain if it's unusual or unclear. Skip obvious ones like "students" or "coffee", "angel" etc.
   - If it's a common name, mention usage statistics (e.g., "Common surname, ~50k people globally")
   - Explain obscure names, non-English words, or technical terms, acrynms, romanised foriegn languages, etc.
   - **Username/Gamertag value**: If the name is highly suited as a username or gamertag (demon, killer, anon, legend, chad, ghost, etc), mention it. These are valuable for personal branding in gaming/crypto communities.

3. **Club membership**: If the name belongs to a club (e.g., "999 Club #1,234 @ENS999club"):
   - this means it's part of a "club" or "category" of ens names, that are generally considered to be of higher value or quality due to their discoverability.
   - Mention it if it adds context (e.g., "This is #1,234 in the 999 Club")
   - If it's a special one, perhaps a rare or most well known in that club, highlight it.
   - If its a a special pattern in a club, eg 0101 for 10k club, or 101 for 999 club, highlight it.
   - 999 club and 10k clubs do not need much explination. their value is self-evident by the frequent trades, and high floor prices.
   - if its a low number for names, get the forebears data for it eg sam is 101st most popular name in the world, mostly in US and UK.
   - if its a prepunk club, can be interesting. there are almost 80k of them, just means they are OG ens names. sub 10k, sub 1k, sub 100 are increasingly valuable. a sub 100 name could sell for thousands even if it has no linguistic value. 

4. **Trading patterns** based on the user tx history and current holdings provided: Only mention if unusual
   - name buying frequency
   - buyer and seller total volumes (NOTE: High ETH volume + low USD volume = OG buyer from early days when ETH was cheaper)
   - Quick flips or unusual timing
   - Big profit or loss on this specific sale
   - **Current holdings patterns**: Look for themes in what they're collecting (e.g., all animals, all 3-letter names, all dictionary words, all numbers, specific category focus).
   - **NAME EXAMPLES**: ONLY if the buyer already owns DIRECTLY SIMILAR names to the one being purchased, mention one or two specific examples. The names must be genuinely related.
     - GOOD: Buying "aug.eth" and they own "sep.eth" and "oct.eth" (all months)
     - GOOD: Buying "nathan.eth" and they own "emma.eth" and "sarah.eth" (all first names)
     - GOOD: Buying "coffee.eth" and they own "tea.eth" and "latte.eth" (all beverages)
     - BAD: Buying "aug.eth" and they own "0000000002.eth" and "04040404.eth" (NOT similar - don't mention)
     - BAD: Buying "sam.eth" and they own "12345.eth" (NOT similar - don't mention)
   - If you can't find genuinely similar names, just describe the general pattern without examples
   - Keep it to 1-2 example names max - only if they're relevant
   - **CRITICAL**: When describing patterns, ONLY say what they ARE doing. NEVER add "rather than", "instead of", or "as opposed to" phrases.
   
   🚩 **WASH TRADING DETECTION** (critical - don't downplay):
   - Fresh buyer wallet (no/little history) + serial mint-flipper seller = LIKELY wash trade
   - mint and then sold it on the same day, or within a few days. 90% chance its a wash trade.
   - Multiple red flags together = suspicious, not "ordinary market churn"
   - Red flags: fresh wallets, rapid mint-flips for profit, repeated pattern.
   - If it looks unnatural, SAY SO. Don't dismiss it as normal activity.
   - however for 10k and 999 clubs, be far more lenient, wash trading doesn't really exist for these clubs, as they are highly liquid and heavily traded.
   - **IMPORTANT**: If there are NO red flags, do not mention wash trading at all. Only report suspicious activity if it exists.

5. **Market context**: anything interesting about this transaction?
   - Notable buyer or seller behavior?

CRITICAL RULES:
- Don't state obvious things (like "this is a registration not a sale" when type is already clear)
- Don't explain obvious name meanings
- Don't list stats just because you have them
- Don't repeat the price or name from the main tweet
- NEVER mention legal/trademark/IP/copyright issues - these are boring and irrelevant for web3 names
- give low weight "commercial uses" or "brand protection" - ENS names are primarily usernames/identities
- not interested in brandability or how it could be used in a brand or company name.
- NEVER mention the ABSENCE of problems (e.g., "no wash trading signals", "no red flags", "nothing suspicious")
- **MULTIPLE MEANINGS = GOOD**: If a name has multiple meanings or uses, frame this as POSITIVE (cross-market appeal, more potential buyers). NEVER use phrases like "brings search noise", "ambiguous", "confusing", or other negative framing for versatility.
  - BAD: "also brings search noise from other AUG uses"
  - GOOD: "works across multiple contexts - crypto ticker, common abbreviation, and username appeal"
  - Think: versatility = more potential buyers = market strength
  
- **ABSOLUTELY FORBIDDEN PHRASES** - These will make your response invalid:
  ❌ "rather than x"
  ❌ "instead of x"  
  ❌ "as opposed to x"
  ❌ "not a flipper" / "not flipping" / "not selling"
  ❌ "one-off flips" in contrast statements
  ❌ "speculative flips" when contrasting with what they ARE doing
  ❌ "small crypto ticker activity" or any minimizing language about crypto uses (either mention it prominently or skip it)
  ❌ "marginal upside" or "adds marginal value" (don't mention if not significant)
  ❌ "not tied to a major protocol or token" / "not a major token" / "not associated with" / "though it is not" (NEVER mention what crypto connections DON'T exist)
  
- **CORRECT WAY** - State only the positive behavior:
  ✅ "building a collection"
  ✅ "accumulating utility-first identities"
  ✅ "holding long-term"
  
- **THE RULE**: If you're about to type "rather than", "instead of", or "as opposed to" → DELETE IT. End the sentence before that phrase.
- Only report what IS present and interesting, never what ISN'T or what it's NOT like
- NEVER offer personal services or suggest you can help ("I can look up..." "let me know if...")
- NEVER ask questions to the reader
- You are an automated analysis bot, not a person offering services
- NEVER use the word "edgy" - use alternatives like "bold", "distinctive", "unconventional", or just describe what type of name it is (gaming, dark/fantasy themed, etc.)

FORMATTING NUMBERS & TIME:
- **Time references**: Convert days to human-readable format
  - 30 days or less: "X days ago"
  - 31-60 days: "~1 month ago"
  - 61-89 days: "~2 months ago"
  - 90-364 days: "~X months ago" (round to nearest month)
  - 365-729 days: "~1 year ago" or "~1.5 years ago"
  - 730+ days: "~X years ago" or "~X years Y months ago" for significant events
  - Examples: "588 days ago" → "~1 year 7 months ago", "45 days ago" → "~1.5 months ago"
  
- **Price comparisons**: Include actual numbers when they're significant
  - BAD: "previously sold for a much higher sum"
  - GOOD: "previously sold for 0.5 ETH, now trading at 0.1 ETH"

REFERENCING BUYERS/SELLERS:
When mentioning the buyer or seller, use the exact formatted handle from the EVENT section:
- If shown as "name.eth @handle" → use "name.eth @handle"
- If shown as "name.eth" → use "name.eth"
- If shown as "0xabcd...1234" → use "0xabcd...1234"
Examples: "The buyer jim.eth @jim has been collecting..." or "The buyer 0x23af...07s3 is a fresh wallet..."

GOOD EXAMPLE WITH TL;DR:
"TL;DR: Premium first name with 4x return after 3-year hold.

Edward is one of the most common English names globally (forebears shows 6 million people with this name). The buyer collector.eth @collector has been focused on traditional first names, already owning nathan.eth and emma.eth, and has picked up 6 more over 2 months with all holdings retained. The seller held for ~3 years and made 4x. Classic identity names are seeing renewed interest."

BAD EXAMPLES:
"Common given name, nothing exotic. Note there are live trademark filings using the same word, so commercial uses could carry legal risk in some industries." ❌ BORING: Skip legal/IP/trademark talk

"Umbreon sits under Pokémon Company IP, which limits commercial listing and resale paths." ❌ BORING: Don't discuss IP ownership or "commercial" concerns

"The buyer has 31 buys with zero sells, not quick flipping." ❌ WRONG: Don't use "not X" phrasing. Instead say: "The buyer has accumulated 31 names with all holdings retained, building a focused collection."

"aug.eth is a three-letter string with gaming, biotech, and music uses, and some small crypto ticker activity." ❌ WRONG: Don't minimize crypto uses with "small" - either highlight it prominently or skip it entirely.

"The buyer shows an accumulation pattern, holding short and numeric identities like 0000000002.eth and 04040404.eth." ❌ WRONG when buying "aug.eth": These aren't similar names! Only mention holdings if they're directly related to the name being purchased.

"That pattern points to building utility-first identities rather than speculative one-off flips." ❌ WRONG: Delete everything after "identities". Just say: "That pattern points to building utility-first identities." The "rather than" comparison is unnecessary and breaks the positive-only rule.

"The buyer is accumulating names instead of flipping them." ❌ WRONG: Just say "The buyer is accumulating names." No "instead of" needed.

"The string has real-world and cultural uses—barber shops, music, film—and appears in NFT drops and community crypto outreach, though it is not tied to a major protocol or token." ❌ WRONG: The phrase "though it is not tied to" is a negation. Either mention a significant crypto connection or skip crypto entirely. Never mention what ISN'T there.

"This string links to a Solana token called JPOW AI, and it works as a compact gamer handle." ❌ WRONG: If the research shows this token has only $60k market cap and ranks 8500 on CoinGecko, it's NOT notable. Tokens under $5M market cap should be completely ignored. Skip the crypto mention entirely.

TERMINOLOGY:
- Use "fandom names", "fan community names", or "community clubs" instead of "franchise names"
- ENS names are usernames/identities/gamertags, generally not corporate assets.`;
  }

  /**
   * Clean Twitter handle (remove @ prefix and whitespace)
   */
  private cleanTwitterHandle(handle: string): string {
    return handle.replace(/^@/, '').trim();
  }

  /**
   * Format a display handle for buyer/seller references in AI prompts
   * Matches the tweet formatter's getDisplayHandle logic:
   * - "name.eth @handle" (if both ENS and Twitter exist)
   * - "name.eth" (if only ENS exists)
   * - "@handle" (if only Twitter exists - edge case)
   * - "0xabcd...1234" (truncated address fallback)
   */
  private formatDisplayHandle(
    ensName: string | null | undefined,
    twitter: string | null | undefined,
    address: string
  ): string {
    // Sanitize ENS name to prevent prompt injection
    const sanitizedEnsName = ensName ? this.sanitizeLabel(ensName.replace(/\.eth$/i, '')) + '.eth' : null;
    
    // Clean and sanitize Twitter handle
    const cleanedTwitter = twitter ? this.cleanTwitterHandle(twitter) : null;
    const sanitizedTwitter = cleanedTwitter ? this.sanitizeLabel(cleanedTwitter) : null;
    
    if (sanitizedEnsName && sanitizedTwitter) {
      return `${sanitizedEnsName} @${sanitizedTwitter}`;
    } else if (sanitizedEnsName) {
      return sanitizedEnsName;
    } else if (sanitizedTwitter) {
      return `@${sanitizedTwitter}`;
    }
    
    // Fallback to truncated address (already safe as it's a hex string)
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
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

    // Sanitize token name to prevent prompt injection
    const sanitizedTokenName = this.sanitizeLabel(event.tokenName.replace(/\.eth$/i, '')) + '.eth';

    // Format display handles for buyer and seller
    const buyerHandle = this.formatDisplayHandle(event.buyerEnsName, event.buyerTwitter, event.buyerAddress);
    const sellerHandle = event.sellerAddress 
      ? this.formatDisplayHandle(event.sellerEnsName, event.sellerTwitter, event.sellerAddress)
      : null;

    // Format event details
    let prompt = `EVENT:\n`;
    prompt += `- Type: ${event.type}\n`;
    prompt += `- Name: ${sanitizedTokenName}\n`;
    prompt += `- Price: ${event.price} ETH ($${event.priceUsd.toLocaleString()})\n`;
    
    if (event.type === 'bid') {
      prompt += `- Bidder: ${buyerHandle}\n`;
      if (sellerHandle) {
        prompt += `- Current Owner: ${sellerHandle}\n`;
      }
    } else {
      prompt += `- Buyer: ${buyerHandle}\n`;
      if (event.type === 'sale' && sellerHandle) {
        prompt += `- Seller: ${sellerHandle}\n`;
      }
    }
    
    // Include club membership if available (sanitized)
    if (clubInfo) {
      const sanitizedClubInfo = this.sanitizeLabel(clubInfo);
      prompt += `- Club: ${sanitizedClubInfo}\n`;
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

    // Format buyer/bidder stats
    const buyerLabel = event.type === 'bid' ? 'BIDDER STATS' : 'BUYER STATS';
    prompt += `\n${buyerLabel} (${buyerStats.ensName || 'address ' + buyerStats.address.slice(0, 10) + '...'}):\n`;
    prompt += `- Buys: ${buyerStats.buysCount} (${buyerStats.buysVolume.toFixed(4)} ETH / $${buyerStats.buysVolumeUsd.toLocaleString()})\n`;
    prompt += `- Sells: ${buyerStats.sellsCount} (${buyerStats.sellsVolume.toFixed(4)} ETH / $${buyerStats.sellsVolumeUsd.toLocaleString()})\n`;
    prompt += `- Activity: ${buyerStats.transactionsPerMonth.toFixed(1)} txns/month\n`;

    // Format seller/owner stats (if sale or bid with owner data)
    if (sellerStats) {
      const sellerLabel = event.type === 'bid' ? 'CURRENT OWNER STATS' : 'SELLER STATS';
      prompt += `\n${sellerLabel} (${sellerStats.ensName || 'address ' + sellerStats.address.slice(0, 10) + '...'}):\n`;
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

    // Format buyer current holdings (all names)
    if (buyerStats.currentHoldings && buyerStats.currentHoldings.length > 0) {
      prompt += `\nBUYER CURRENT HOLDINGS (${buyerStats.currentHoldings.length} names${buyerStats.holdingsIncomplete ? ' - incomplete data' : ''}):\n`;
      prompt += buyerStats.currentHoldings.join(', ');
      prompt += `\n`;
    }

    // Format seller current holdings (all names)
    if (sellerStats && sellerStats.currentHoldings && sellerStats.currentHoldings.length > 0) {
      prompt += `\nSELLER CURRENT HOLDINGS (${sellerStats.currentHoldings.length} names${sellerStats.holdingsIncomplete ? ' - incomplete data' : ''}):\n`;
      prompt += sellerStats.currentHoldings.join(', ');
      prompt += `\n`;
    }

    // Add data quality notes if APIs returned incomplete data
    const { metadata } = context;
    const dataIssues: string[] = [];
    
    if (metadata.tokenDataIncomplete) {
      dataIssues.push('token history incomplete (pagination stopped early)');
    }
    if (metadata.buyerDataIncomplete) {
      dataIssues.push('buyer history incomplete (pagination stopped early)');
    }
    if (metadata.sellerDataIncomplete && event.type === 'sale') {
      dataIssues.push('seller history incomplete (pagination stopped early)');
    }
    
    if (dataIssues.length > 0) {
      prompt += `\n⚠️ DATA LIMITATIONS: ${dataIssues.join(', ')}. The data shown is partial, not complete. Don't draw fundamental conclusions about trading patterns or behavior. Focus on what we can verify.\n`;
    }

    prompt += `\n---

YOUR TASK: Look at all this data and pick out what's ACTUALLY INTERESTING to market watchers. Not all of it matters.

Ask yourself:
- Is the name meaning worth explaining? maybe it's obscure, or a non-english word, or an acronym, or a romanised foreign language, etc. if its self evident, skip it or keep it very short
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

    if (text.length > 1200) {
      logger.warn(`Response too long: ${text.length} characters (max 1200 for Twitter Premium)`);
      return false;
    }

    return true;
  }
}

