import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { LLMPromptContext } from './dataProcessingService';
import { CLUB_LABELS } from '../constants/clubMetadata';

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
      name: 'gpt-5.4-2026-03-05',
      maxInputTokens: 128000,
      description: 'GPT-5.4 for tweet generation'
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
   * Format holdings array as comma-separated names with [Category] annotations.
   * Names with clubs get brackets: "frodo.eth [Top Fantasy], vanish.eth [BIP 39], bergson.eth"
   */
  private formatHoldingsWithClubs(holdings: { name: string; clubs: string[] }[]): string {
    return holdings.map(h => {
      if (h.clubs.length === 0) return h.name;
      const labels = h.clubs
        .map(slug => CLUB_LABELS[slug] || slug)
        .join(', ');
      return `${h.name} [${labels}]`;
    }).join(', ');
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
     - Only consider tokens with market cap ABOVE $25 million as notable
     - Tokens under $25M market cap are too small to mention
     - Example: A token at $60k market cap, rank 8500 = NOT notable, skip it
     - **CRITICAL: Name must be EXACT 1:1 match** - if the ENS name is "verify.eth", only report on a token called exactly "verify" or "VERIFY", not "zkverify" or "verifyDAO" or similar
     - Partial matches or names containing the search term are NOT relevant

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
      const tweetText = `GrailsAI ✨\n\n${rawText}`;
      
      // Validate response (with title included)
      if (!this.validateResponse(tweetText)) {
        throw new Error(`Invalid response: ${tweetText.length} characters (max 900)`);
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
    return `You are a sharp, opinionated ENS market analyst. You write short, punchy commentary on domain sales, registrations, and bids. You have a personality. You call it like you see it.

YOUR TASK:
Look at all the data and find the ONE OR TWO things that actually matter. Lead with the most interesting angle. Be direct, be spicy, be confident.

PRIORITY ORDER (what to focus on, most important first):

0. **IDENTITY CONNECTIONS** (CHECK FIRST — highest value insight):
   - Does the buyer/seller handle match or relate to the name? (e.g. kalis.eth buying revoke.eth → likely Revoke.cash founder Rosco Kalis securing their brand)
   - When research reveals a real-world project, person, or brand behind the name AND the buyer's identity connects to it, LEAD WITH THIS
   - These insights are rare but when they exist, they're the whole story

1. **NAME PRICE HISTORY & HOLD DURATION** (LEAD WITH THIS when interesting):
   - What was it last sold for? What was it registered/minted for? How long held?
   - Price trajectory: 5x gain? Sold at a loss? Held 3 years for pennies?
   - Call out overpays and steals. "Paid 2 ETH for a name that last sold for 0.1 ETH" = overpay, say so.
   - "Registered for $5 two years ago, just sold for 2 ETH" = incredible flip, highlight it.
   - Seller PNL is gold. Big wins, big losses, break-evens after years of holding. Use actual numbers.

2. **MARKET ACTOR PATTERNS** (check activity history and stats carefully):
   - Is this buyer/seller on a spree? Look at the dates in their history. Multiple sales/buys this week? This month?
   - "This is their 4th sale this week" or "3rd registration today" = the story
   - Selling patterns: Are they liquidating? Clearing out a portfolio? Rotating into different categories?
   - Buying patterns: Building a specific collection? Sniping deals? Registering in bulk?
   - Registration binges: Someone registering 5+ names in a day is interesting
   - This person's VELOCITY and BEHAVIOR PATTERN matters more than their individual stats
   - **PERSONAL VOLUME is important context**: Check their total buy/sell volume in ETH and USD
     - 50+ ETH total volume = serious trader, worth noting
     - 100+ ETH = heavyweight, definitely mention ("has moved 100+ ETH in ENS trades")
     - 500+ ETH = whale-level ENS trader, lead with this
     - High ETH volume + low USD volume = OG buyer from when ETH was cheap. That's interesting context
     - Compare buy volume vs sell volume: net buyer (accumulator) vs net seller (liquidator)
   - **RECENT ACTIVITY is high signal**: Look at the activity history dates closely
     - Multiple transactions in the last 7 days = actively trading right now, mention it
     - Cluster of sells = "clearing out", cluster of buys = "on an acquisition spree"
     - Recent activity trumps lifetime stats. Someone with 200 lifetime trades but 5 this week is on a hot streak

3. **NAME RESEARCH (be selective but don't omit key connections)**:
   - 1-2 sentences MAX, but USE it when it matters
   - **ALWAYS include** when research reveals the buyer/seller is likely the founder/creator/team behind a matching project, or a major crypto protocol/tool ($25M+)
   - Skip when the name is obvious/common and research is just a dictionary definition
   - Explain obscure names, non-English words, acronyms, romanised foreign languages
   - Username/gamertag appeal worth noting for names like demon, killer, anon, legend, chad, ghost

4. **CATEGORY MEMBERSHIP & MARKET CONTEXT**: If CATEGORY CONTEXT data is provided:
   - You'll receive club stats and recent activity for each category — use this as **general background context**, not as a primary talking point
   - Don't lead with or overemphasize floor prices. Floor is just one data point — mention it only if it's genuinely relevant (e.g. a sale at 10x floor, or a name selling below floor)
   - Category stats help you understand the broader market: is this category active or quiet? Scarce or oversupplied? But keep references brief and natural
   - 999 and 10k categories are self-evident. No need to explain what they are
   - Prepunk: Only mention if sub-10k (increasingly rare), sub-1k (very rare), or sub-100 (extremely valuable)
   - Don't list raw stats — if you reference category data, weave it in naturally in 1 sentence max

5. **COLLECTION PATTERNS from holdings**: Only if directly relevant
   - Holdings show names with optional [Category] annotations — e.g. "frodo.eth [Top Fantasy], vanish.eth [BIP 39]"
   - Use categories to identify participant themes (fantasy names, dictionary words, number clubs, etc.)
   - **NAME EXAMPLES**: ONLY mention specific holdings if they're DIRECTLY SIMILAR to the purchased name
     - GOOD: Buying "aug.eth" and they own "sep.eth" and "oct.eth" (all months)
     - BAD: Buying "aug.eth" and they own "0000000002.eth" (NOT similar)
   - Keep to 1-2 examples max. If no genuinely similar names exist, describe the general pattern

**FOR BIDS ONLY** (⚠️ IGNORE FOR SALES AND REGISTRATIONS):
- The "buyer" is the bidder, the "seller" is the current owner
- Key angles:
  • Many bids at similar prices = "spray and pray" lowball hunting
  • Owner's selling behavior: Have they EVER sold at this price range? If not, say so
  • If owner HAS sold comparable names at this price: "Owner has accepted similar offers before"
  • Bid relative to the name's sale history
- **PORTFOLIO CAVEAT**: If portfolio value < bid price, data is incomplete. DO NOT mention portfolio at all
- **DO NOT analyze for wash trading on bids**

**PORTFOLIO (ONLY mention if $100k+ or if it creates a funny/notable contrast)**:
- Under $100k: skip it entirely. Not interesting enough to mention
- $100k-$500k: mention only if it creates a notable contrast (e.g., big portfolio buying a $10 name)
- $500k+: worth a brief mention as context ("whale wallet")
- $1M+: definitely mention
- For bids: portfolio is from same time as bid
- For sales/registrations: portfolio is AFTER the purchase (money already spent)
- ONLY report total USD value. Never break down individual token amounts
- Multichain presence is ONLY relevant as a wash-trade counter-signal. Do not mention it otherwise

WRITING STYLE:
- Short, punchy sentences. Get to the point fast
- Be spicy. Call out bad deals, overpays, desperation moves, lowball bids
- Mock gently when warranted: "Held for 2 years to make 0.01 ETH profit. Patience of a saint, returns of a savings account"
- Call out overpaying with confidence: "Paid 3x what it last sold for" or "Generous price for a name that sat untouched for a year"
- Highlight steals: "Absolute snipe at this price given the last sale was 5x higher"
- Be direct. No hedging. "This is a liquidation move" not "This might suggest liquidation"
- Humor should come from the DATA (price mismatches, hold times, ironic names, behavioral patterns)
- Avoid forced jokes, puns, or slang like "on a tear," "nabbed," "scooped up"
- You have 850 characters max. Every word must earn its place

FORMATTING:
- NO TL;DR section. Just write the analysis directly. Most important insight first
- NEVER use dashes (—, –, or - at start of lines)
- Use periods and commas. Short paragraphs
- 4-6 sentences total. Front-load the interesting stuff

🚩 **WASH TRADING DETECTION (sales/registrations ONLY, NOT bids)**:
ANY of these combinations = CALL IT A WASH TRADE. Do not hedge. Do not say "either/or." State it as fact:
- Fresh/empty buyer wallet + seller who mints and flips = WASH TRADE. Say so directly
- Buyer and seller are the same address = WASH TRADE. Say so directly
- Name minted and sold same day or within days at inflated price = WASH TRADE. Say so directly
- Seller has a pattern of minting cheap names and "selling" them to fresh wallets = WASH TRADE. Say so directly

NEVER hedge with "either X happened or Y." If the signals are there, the conclusion is wash trading. Period.
NEVER frame wash trading as clever strategy ("found a lane to print"). Call it what it is
The word "wash" MUST appear in your response when you detect these patterns

When it's NOT a wash trade:
- 10k and 999 clubs with established buyer wallets: be more lenient, these are highly liquid
- If buyer has real history (multiple buys, sells, diverse names) it's probably real
- If NO red flags exist, don't mention wash trading at all

CRITICAL RULES:
- Don't state obvious things or repeat the price/name from the main tweet
- Don't explain obvious name meanings (coffee, angel, students = skip)
- Don't list stats just because you have them. Pick what matters
- NEVER mention legal/trademark/IP/copyright issues
- NEVER mention "commercial uses" or "brand protection"
- NEVER mention the ABSENCE of problems ("no wash trading signals", "no red flags")
- NEVER use the word "comp" or "comps"
- NEVER offer services or ask questions ("I can look up..." "let me know...")
- You are an automated bot, not a person
- **MULTIPLE MEANINGS = GOOD**: versatility = more buyers = market strength
- Only report what IS present and interesting, never what ISN'T
- NEVER use the word "edgy"
- NEVER use "rather than", "instead of", "as opposed to", "not a flipper", "not flipping"
- State only the positive behavior: "building a collection", "holding long-term"

FORMATTING NUMBERS & TIME:
- 30 days or less: "X days ago"
- 31-60 days: "~1 month ago"
- 90-364 days: "~X months ago"
- 365-729 days: "~1 year ago" or "~1.5 years ago"
- 730+ days: "~X years ago"
- Use actual numbers for price comparisons: "last sold for 0.5 ETH, now at 0.1 ETH"

REFERENCING BUYERS/SELLERS:
Use the exact formatted handle from the EVENT section:
- "name.eth" → use "name.eth"
- "0xabcd...1234" → use "0xabcd...1234"
- NEVER include @mentions or Twitter handles in your response

GOOD EXAMPLES:
"Registered for $8 in 2021, now flipped for 1.5 ETH. The seller held for 4 years and finally cashed out a 300x. The buyer collector.eth @collector already owns emma.eth and sarah.eth, adding another premium first name to a growing set."

"This is seller.eth's 5th sale this week. Looks like a portfolio clearance. All mid-tier names, all sold within 10% of floor. Efficient liquidation."

"0.3 ETH for a name that last traded at 0.05 ETH six months ago. That's a 6x markup and the buyer paid it without blinking. Bold conviction or expensive FOMO."

BAD EXAMPLES:
"The buyer has a $15k portfolio spread across Ethereum and Base." ❌ BORING: Under $100k, skip portfolio
"Active on multiple chains including Ethereum, Base, and Polygon." ❌ BORING: Don't mention multichain unless wash-trade relevant
"Common given name, nothing exotic." ❌ OBVIOUS: Skip obvious name meanings entirely

TERMINOLOGY:
- Use "onchain" not "on-chain"
- Use "multichain" not "multi-chain"
- Use "fandom names" or "community clubs" instead of "franchise names"
- ENS names are usernames/identities/gamertags, not corporate assets
- Registrations and mints ARE market activity and price history. A name minted for 2 ETH has a cost basis. Don't say "no prior sale history" or "zero market activity" when there's a registration — the mint IS the prior event.

NUMERICAL FORMATTING:
- Round all ETH values to 2 decimal places (e.g. "2.17 ETH" not "2.1721 ETH", "0.83 ETH" not "0.8279 ETH")
- Only use more precision for very small values under 0.01 ETH

NOTE: Your response will be prefixed with "AI insight:" automatically, so don't include that in your text.`;
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
    
    // NOTE: Twitter @mentions disabled — Twitter API is blocking mentions via API (spam crackdown, Mar 2026)
    // To re-enable: uncomment the Twitter handle block below and remove the simplified version
    // const cleanedTwitter = twitter ? this.cleanTwitterHandle(twitter) : null;
    // const sanitizedTwitter = cleanedTwitter ? this.sanitizeLabel(cleanedTwitter) : null;
    // 
    // if (sanitizedEnsName && sanitizedTwitter) {
    //   return `${sanitizedEnsName} @${sanitizedTwitter}`;
    // } else if (sanitizedEnsName) {
    //   return sanitizedEnsName;
    // } else if (sanitizedTwitter) {
    //   return `@${sanitizedTwitter}`;
    // }
    
    if (sanitizedEnsName) {
      return sanitizedEnsName;
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
    const { event, tokenInsights, buyerStats, sellerStats, buyerActivityHistory, sellerActivityHistory, clubInfo, clubContext, metadata } = context;

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

    // Programmatic wash trade flag: same buyer and seller address
    if (event.type === 'sale' && event.sellerAddress &&
        event.buyerAddress.toLowerCase() === event.sellerAddress.toLowerCase()) {
      prompt += `- ⚠️ SAME ADDRESS: Buyer and seller are the SAME wallet. This is a self-trade.\n`;
    }

    // Known account: ENS Fairy
    if (event.type === 'registration' && event.buyerEnsName?.toLowerCase() === 'ensfairy.eth') {
      prompt += `- ℹ️ KNOWN ACCOUNT: ensfairy.eth is a public-good entity that registers names preemptively to gift them to the matching companies/projects before others get them.\n`;
    }
    
    // Include category membership if available (sanitized)
    if (clubInfo) {
      const sanitizedClubInfo = this.sanitizeLabel(clubInfo);
      // Pluralize based on comma count (multiple categories)
      const categoryLabel = clubInfo.includes(',') ? 'Categories' : 'Category';
      prompt += `- ${categoryLabel}: ${sanitizedClubInfo}\n`;
    }

    // Include club context (stats + recent activity) if available
    if (clubContext && clubContext.length > 0) {
      prompt += `\nCATEGORY CONTEXT:\n`;
      for (const club of clubContext) {
        const s = club.stats;
        const floorStr = s.floorPriceEth !== null ? `${s.floorPriceEth.toFixed(4)} ETH` : 'N/A';
        prompt += `\n[${s.displayName}] (${s.memberCount.toLocaleString()} members)\n`;
        prompt += `  Floor: ${floorStr} | Holders: ${s.holdersCount.toLocaleString()} | Listed: ${s.listingsCount} | Available: ${s.availableCount.toLocaleString()}\n`;
        prompt += `  Sales — 1w: ${s.salesCount1w} (${s.salesVolumeEth1w.toFixed(2)} ETH) | 1mo: ${s.salesCount1mo} (${s.salesVolumeEth1mo.toFixed(2)} ETH) | 1y: ${s.salesCount1y} (${s.salesVolumeEth1y.toFixed(2)} ETH)\n`;
        prompt += `  Regs — 1w: ${s.regCount1w} | 1mo: ${s.regCount1mo} | 1y: ${s.regCount1y}\n`;

        if (club.recentActivity.length > 0) {
          prompt += `  Recent:\n`;
          for (const a of club.recentActivity) {
            const priceStr = a.priceEth > 0
              ? `${a.priceEth.toFixed(4)} ETH`
              : `${a.priceToken.toFixed(2)} ${a.currencySymbol}`;
            const typeLabel = a.eventType === 'mint' ? 'reg' : 'sale';
            prompt += `    ${a.name} ${typeLabel} ${priceStr} (${a.daysAgo}d ago)\n`;
          }
        }
      }
    }

    // Include name research if available
    if (nameResearch) {
      prompt += `\nNAME RESEARCH:\n${nameResearch}\n`;
    }

    // Format token insights (skip if data fetch failed)
    if (metadata.tokenDataUnavailable) {
      prompt += `\nTOKEN HISTORY: ⚠️ DATA UNAVAILABLE (API error). Do not assume anything about this name's trading history.\n`;
    } else {
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
    }

    // Format buyer/bidder stats (skip if data fetch failed)
    const buyerLabel = event.type === 'bid' ? 'BIDDER STATS' : 'BUYER STATS';
    if (metadata.buyerDataUnavailable) {
      prompt += `\n${buyerLabel}: ⚠️ DATA UNAVAILABLE (API error). Do not assume this is a fresh wallet or new buyer. Activity data could not be fetched.\n`;
    } else {
      prompt += `\n${buyerLabel} (${buyerStats.ensName || 'address ' + buyerStats.address.slice(0, 10) + '...'}):\n`;
      prompt += `- Buys: ${buyerStats.buysCount} (${buyerStats.buysVolume.toFixed(4)} ETH / $${buyerStats.buysVolumeUsd.toLocaleString()})\n`;
      prompt += `- Sells: ${buyerStats.sellsCount} (${buyerStats.sellsVolume.toFixed(4)} ETH / $${buyerStats.sellsVolumeUsd.toLocaleString()})\n`;
      prompt += `- Activity: ${buyerStats.transactionsPerMonth.toFixed(1)} txns/month\n`;

      if (event.type !== 'bid' && buyerStats.buysCount + buyerStats.sellsCount <= 1) {
        prompt += `- ⚠️ FRESH WALLET: Buyer has little or no ENS trading history. Wash trade signal if seller is a mint-flipper.\n`;
      }
    }
    
    // Buyer detail sections (only if data was successfully fetched)
    if (!metadata.buyerDataUnavailable) {
      if (buyerStats.biddingStats) {
        const bs = buyerStats.biddingStats;
        prompt += `- Bidding activity: ${bs.totalBids} bids placed, ${bs.totalBidVolume.toFixed(4)} ETH total (avg ${bs.averageBidAmount.toFixed(4)} ETH per bid)\n`;
        
        if (bs.bidPatterns.commonThemes.length > 0) {
          prompt += `- Bid patterns: ${bs.bidPatterns.commonThemes.join(', ')} (e.g., ${bs.bidPatterns.exampleNames.slice(0, 3).join(', ')})\n`;
        }
        
        if (bs.recentBids.length > 0) {
          prompt += `- Recent bids (${Math.min(bs.recentBids.length, 5)}):\n`;
          for (const bid of bs.recentBids.slice(0, 5)) {
            prompt += `  • ${bid.name}: ${bid.amount.toFixed(4)} ETH, ${bid.daysAgo}d ago\n`;
          }
        }
      }
      
      if (buyerStats.portfolio && buyerStats.portfolio.totalValueUsd >= 100000) {
        const p = buyerStats.portfolio;
        prompt += `\nPORTFOLIO (${buyerLabel}):\n`;
        prompt += `- Total value: $${p.totalValueUsd.toLocaleString()}\n`;
        
        const activeChains = Object.entries(p.crossChainPresence)
          .filter(([_, active]) => active)
          .map(([chain, _]) => chain);
        if (activeChains.length <= 1) {
          prompt += `- Single-chain wallet (wash trade signal)\n`;
        }
      }
    }

    // Format seller/owner stats (if sale or bid with owner data)
    if (sellerStats) {
      const sellerLabel = event.type === 'bid' ? 'CURRENT OWNER STATS' : 'SELLER STATS';
      if (metadata.sellerDataUnavailable) {
        prompt += `\n${sellerLabel}: ⚠️ DATA UNAVAILABLE (API error). Do not assume anything about seller's trading history.\n`;
      } else {
        prompt += `\n${sellerLabel} (${sellerStats.ensName || 'address ' + sellerStats.address.slice(0, 10) + '...'}):\n`;
        prompt += `- Buys: ${sellerStats.buysCount} (${sellerStats.buysVolume.toFixed(4)} ETH / $${sellerStats.buysVolumeUsd.toLocaleString()})\n`;
        prompt += `- Sells: ${sellerStats.sellsCount} (${sellerStats.sellsVolume.toFixed(4)} ETH / $${sellerStats.sellsVolumeUsd.toLocaleString()})\n`;
        prompt += `- Activity: ${sellerStats.transactionsPerMonth.toFixed(1)} txns/month\n`;
        
        if (sellerStats.biddingStats) {
          const ss = sellerStats.biddingStats;
          prompt += `- Bidding activity: ${ss.totalBids} bids placed, ${ss.totalBidVolume.toFixed(4)} ETH total (avg ${ss.averageBidAmount.toFixed(4)} ETH per bid)\n`;
          
          if (ss.bidPatterns.commonThemes.length > 0) {
            prompt += `- Bid patterns: ${ss.bidPatterns.commonThemes.join(', ')} (e.g., ${ss.bidPatterns.exampleNames.slice(0, 3).join(', ')})\n`;
          }
        }
        
        if (sellerStats.portfolio && sellerStats.portfolio.totalValueUsd >= 100000) {
          const p = sellerStats.portfolio;
          prompt += `\nPORTFOLIO (${sellerLabel}):\n`;
          prompt += `- Total value: $${p.totalValueUsd.toLocaleString()}\n`;
          
          const activeChains = Object.entries(p.crossChainPresence)
            .filter(([_, active]) => active)
            .map(([chain, _]) => chain);
          if (activeChains.length <= 1) {
            prompt += `- Single-chain wallet (wash trade signal)\n`;
          }
        }
      }
    }

    // Format buyer activity history (only if data was fetched)
    if (!metadata.buyerDataUnavailable && buyerActivityHistory.length > 0) {
      prompt += `\nBUYER FULL HISTORY (${Math.min(buyerActivityHistory.length, 10)} recent):\n`;
      const recentBuyerActivity = buyerActivityHistory.slice(-10);
      for (const activity of recentBuyerActivity) {
        const date = new Date(activity.timestamp * 1000).toISOString().slice(0, 10);
        const tokenName = activity.tokenName ? activity.tokenName.slice(0, 20) : 'unknown';
        prompt += `- ${date}: ${activity.type} ${tokenName} for ${activity.price.toFixed(4)} ETH [${activity.role}]\n`;
      }
    }

    // Format seller activity history (only if data was fetched)
    if (!metadata.sellerDataUnavailable && sellerActivityHistory && sellerActivityHistory.length > 0) {
      prompt += `\nSELLER FULL HISTORY (${Math.min(sellerActivityHistory.length, 10)} recent):\n`;
      const recentSellerActivity = sellerActivityHistory.slice(-10);
      for (const activity of recentSellerActivity) {
        const date = new Date(activity.timestamp * 1000).toISOString().slice(0, 10);
        const tokenName = activity.tokenName ? activity.tokenName.slice(0, 20) : 'unknown';
        prompt += `- ${date}: ${activity.type} ${tokenName} for ${activity.price.toFixed(4)} ETH [${activity.role}]\n`;
      }

      // Detect mint-flipper pattern: seller has mints + quick sells at much higher prices
      if (event.type === 'sale') {
        const sellerMints = sellerActivityHistory.filter(a => a.type === 'mint');
        const sellerSells = sellerActivityHistory.filter(a => a.role === 'seller' && a.type === 'sale');
        if (sellerMints.length >= 2 && sellerSells.length >= 2) {
          const avgMintPrice = sellerMints.reduce((s, a) => s + a.price, 0) / sellerMints.length;
          const avgSellPrice = sellerSells.reduce((s, a) => s + a.price, 0) / sellerSells.length;
          if (avgMintPrice > 0 && avgSellPrice / avgMintPrice >= 10) {
            prompt += `- ⚠️ MINT-FLIPPER: Seller mints at avg ${avgMintPrice.toFixed(4)} ETH and sells at avg ${avgSellPrice.toFixed(4)} ETH (${Math.round(avgSellPrice / avgMintPrice)}x markup). Wash trade signal if buyer is a fresh wallet.\n`;
          }
        }
      }
    }

    // Format buyer current holdings with club annotations (only if buyer data was fetched)
    if (!metadata.buyerDataUnavailable && buyerStats.currentHoldings && buyerStats.currentHoldings.length > 0) {
      prompt += `\nBUYER CURRENT HOLDINGS (${buyerStats.currentHoldings.length} names${buyerStats.holdingsIncomplete ? ' - incomplete data' : ''}):\n`;
      prompt += this.formatHoldingsWithClubs(buyerStats.currentHoldings);
      prompt += `\n`;
    }

    // Format seller current holdings with club annotations (only if seller data was fetched)
    if (!metadata.sellerDataUnavailable && sellerStats && sellerStats.currentHoldings && sellerStats.currentHoldings.length > 0) {
      prompt += `\nSELLER CURRENT HOLDINGS (${sellerStats.currentHoldings.length} names${sellerStats.holdingsIncomplete ? ' - incomplete data' : ''}):\n`;
      prompt += this.formatHoldingsWithClubs(sellerStats.currentHoldings);
      prompt += `\n`;
    }

    // Add data quality notes if APIs returned incomplete data
    const dataIssues: string[] = [];
    
    if (metadata.tokenDataIncomplete) {
      dataIssues.push('token history incomplete (pagination stopped early)');
    }
    // Only mention buyer/seller data if incomplete (not if unavailable - just ignore it)
    if (!metadata.buyerDataUnavailable && metadata.buyerDataIncomplete) {
      dataIssues.push('buyer history incomplete (pagination stopped early)');
    }
    if (event.type === 'sale' && !metadata.sellerDataUnavailable && metadata.sellerDataIncomplete) {
      dataIssues.push('seller history incomplete (pagination stopped early)');
    }
    if (metadata.buyerBidsTruncated) {
      dataIssues.push(`buyer bids limited to latest 500 (${metadata.buyerBidsTruncatedCount} older bids not shown)`);
    }
    if (metadata.sellerBidsTruncated && event.type === 'sale') {
      dataIssues.push(`seller bids limited to latest 500 (${metadata.sellerBidsTruncatedCount} older bids not shown)`);
    }
    
    if (dataIssues.length > 0) {
      prompt += `\n⚠️ DATA LIMITATIONS: ${dataIssues.join(', ')}. The data shown is partial, not complete. Don't draw fundamental conclusions about trading patterns or behavior. Focus on what we can verify.\n`;
    }

    prompt += `\n---

YOUR TASK: Find the ONE OR TWO most interesting angles and write a tight, opinionated take. 700 characters max.

CHECK FIRST:
1. What's the name's price history? Big gain? Big loss? Long hold? This is often the best lead
2. Look at the activity history dates. Is this buyer or seller on a SPREE? Multiple transactions this week/month? That's the story
3. Is the name meaning worth explaining? Only if obscure, non-English, or has a notable crypto connection
4. Any funny contrasts, overpays, or desperate moves worth calling out?

Write 4-6 punchy sentences. Most important insight first. Be spicy. Call out overpays, steals, desperation, and smart moves with confidence. Market watchers want hot takes, not book reports.`;

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

    if (text.length > 900) {
      logger.warn(`Response too long: ${text.length} characters (max 900 for Twitter Premium)`);
      return false;
    }

    return true;
  }
}

