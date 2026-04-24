import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { LLMPromptContext } from './dataProcessingService';
import { CLUB_LABELS } from '../constants/clubMetadata';
import {
  WeeklySummaryData,
  WeeklySnapshotData,
  WeeklyTopParticipant,
  WeeklyBotPost,
  WeeklyThreadTweet,
  WeeklyTweetSection,
} from '../types';

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
  //
  // NOTE: `base` and `weekly` intentionally point at the same model slug
  // (`gpt-5.4-2026-03-05`) but with different `maxInputTokens` — and the
  // weekly path passes `reasoning.effort: 'xhigh'` while the per-event reply
  // path does not. Two entries instead of one because:
  //   - Per-event AI replies use selectModel(estimatedTokens) which compares
  //     against `base.maxInputTokens` (128k) to decide whether to escalate to
  //     the o1 thinking model. Bumping `base.maxInputTokens` to 1.05M would
  //     silently disable that escalation and change reply quality.
  //   - The weekly summary uses the model's full 1.05M context window plus
  //     xhigh reasoning. It never escalates.
  private readonly models: {
    search: ModelConfig;
    base: ModelConfig;
    thinking: ModelConfig;
    weekly: ModelConfig;
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
    },
    weekly: {
      name: 'gpt-5.4-2026-03-05',
      maxInputTokens: 1_050_000,
      // ⚠️ TEMP: thinking effort lowered to 'low' for testing the flow end-to-end.
      // Flip WEEKLY_REASONING_EFFORT back to 'xhigh' before going live (see below).
      description: 'GPT-5.4 with xhigh reasoning for weekly market summary'
    }
  };

  /**
   * ⚠️ TEMP: set to 'low' for fast testing while iterating on the prompt /
   * schema / output shape. Flip back to 'xhigh' before any live posting —
   * 'low' won't produce thread-quality output. The SDK's `ReasoningEffort`
   * type only goes up to 'high' (no 'xhigh'); `as any` cast applied at the
   * call site for that case.
   */
  private static readonly WEEKLY_REASONING_EFFORT: 'low' | 'medium' | 'high' | 'xhigh' = 'high';

  /**
   * Hard ceiling on the OpenAI Responses API call for the weekly summary.
   * The SDK's default 10-min timeout silently failed to fire on a stuck
   * request during initial testing — this explicit per-call timeout
   * guarantees we surface a clear error within 30 minutes no matter what.
   * 30 min is generous (xhigh + 40k-token prompt + JSON schema can
   * legitimately take 5-10 min); should be tightened to ~10 min once the
   * flow is proven.
   */
  private static readonly WEEKLY_API_TIMEOUT_MS = 30 * 60 * 1000;

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
    logger.info(`   Weekly summary model: ${this.models.weekly.name} (max ${this.models.weekly.maxInputTokens.toLocaleString()} tokens, xhigh reasoning)`);
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
    return `You are a sharp, opinionated ENS market analyst. You write short, punchy commentary on domain sales, registrations, bids, and renewals. You have a personality. You call it like you see it.

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
   - **PRICE DROPS**: When a name sells BELOW its last recorded sale, the story is about the SELLER — capitulation, cutting losses, desperation, forced exit, urgency etc.

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

**LISTING CONTEXT** (when a "Listed" price appears in the event data):
- Compare bid price to listing price. Bid at or above listing = serious/aggressive
- Listing prices can also be dreamy, they're not authoritative.

**FOR BIDS ONLY** (⚠️ IGNORE FOR SALES AND REGISTRATIONS):
- The "buyer" is the bidder, the "seller" is the current owner
- Key angles:
  • Many bids at similar prices = "spray and pray" lowball hunting
  • If the name is listed: bid vs ask spread tells a story, near ask = serious buyer
  • Owner's selling behavior: Have they EVER sold at this price range? If not, say so
  • If owner HAS sold comparable names at this price: "Owner has accepted similar offers before"
  • Bid relative to the name's sale history
- **PORTFOLIO CAVEAT**: If portfolio value < bid price, data is incomplete. DO NOT mention portfolio at all
- **DO NOT analyze for wash trading on bids**

**FOR REGISTRATIONS ONLY** (⚠️ CRITICAL):
- There is NO seller. NEVER reference a "seller" for registrations. The registrant obtained the name from the ENS protocol
- If TOKEN HISTORY shows prior sales or mints, this is a RE-REGISTRATION of an expired name. The previous owner let it expire — they threw away whatever they originally paid. That's the story

**FOR REGISTRATIONS WITH RECIPIENT** (when RECIPIENT STATS section is present):
- The "buyer" (minter) is the wallet that sent the transaction and paid for the registration
- The "recipient" is the wallet that received the name — they may or may not be related

**FOR RENEWALS ONLY** (⚠️ CRITICAL — different lens than other event types):
- The renewer is paying to keep names they (or someone they're acting for) already own.
- The "buyer" field is the RENEWER (= tx.from = whoever paid). They may or may not be the owner — anyone can renew anyone's name
- There is NO seller. NEVER reference a "seller" for renewals
- BULK SCALE matters: nameCount in the renewalContext tells you how many names were renewed in one transaction. You have the full list. Use the scale:
  • 1 name = single commitment (often a long-held flagship name being kept alive)
  • 2-10 names = small collection holder maintaining their stash
  • 10-50 names = serious portfolio holder
  • 50+ names = whale-scale renewal maintaining inventory
  • 100+ names = institutional / whale-scale, lead with the scale
- TOP NAMES BY COST: 3-letter and 4-letter names cost dramatically more to renew than commodity names.
- PORTFOLIO PATTERNS in the bulk: Are the names thematically similar? (all 999 club, all 4-digit, all words from a category, all first names?) Identify the COLLECTION THESIS if there is one
- Default tone for renewals is RESPECT for the commitment. Don't mock or judge the quality of names being renewed — the owner already acquired them, renewal IS the conviction signal. Describe the collection factually, then focus on the actor, the cost, or the pattern.
- DON'T analyze for wash trading on renewals — there's no buyer/seller exchange of value, just a commitment payment to the protocol.
- DON'T treat a renewal as a market event. It's not a sale or a price discovery. The "price" is the protocol-determined renewal cost, not market value

**PORTFOLIO (ONLY mention if $100k+ or if it creates a funny/notable contrast)**:
- Under $50k: skip it entirely. Not interesting enough to mention
- $50k-$500k: mention only if it seems relevant.
- $500k+: worth a mention as context ("whale wallet")
- $1M+: definitely mention
- For bids: portfolio is from same time as bid
- For sales/registrations: portfolio is AFTER the purchase (money already spent)
- ONLY report total USD value. Never break down individual token amounts
- Multichain presence is ONLY relevant as a wash-trade counter-signal. Do not mention it otherwise

**YOUR PREVIOUS TWEETS** (when provided):
- You may receive your own recent tweets and past tweets about the same buyer/seller
- DO NOT repeat the same phrasing, sentence structure, metaphors, or jokes you've already used
- Vary your opening style, tone, and angle with every tweet
- If you've tweeted about this person before, you can reference continuity ("back again", "still at it") but keep it brief
- Your audience reads all your tweets — sounding like a broken record kills credibility

WRITING STYLE:
- Short, punchy sentences. Get to the point fast
- Be spicy. 
- Mock gently when warranted: "Held for 2 years to make 0.01 ETH profit. Patience of a saint, returns of a savings account"
- Call out overpaying with confidence: "Paid 3x what it last sold for" or "Generous price for a name that sat untouched for a year"
- Highlight steals: "Absolute snipe. Previous holder paid 5x more and walked away at a loss"
- Be direct. No hedging. "This is a liquidation move" not "This might suggest liquidation"
- Humor should come from the DATA (price mismatches, hold times, ironic names, behavioral patterns)
- Avoid forced jokes, puns, or slang like "on a tear," "nabbed," "scooped up"
- You have 850 characters max. Every word must earn its place

FORMATTING:
- NO TL;DR section. Just write the analysis directly. Most important insight first
- NEVER use dashes (—, –, or - at start of lines)
- Use periods and commas. Short paragraphs
- 4-6 sentences total. Front-load the interesting stuff

🚩 **WASH TRADING DETECTION (for sales ONLY, NOT bids, registrations or renewals)**:
ANY of these combinations = CALL IT A WASH TRADE. Do not hedge. Do not say "either/or." State it as fact:
- Fresh/empty buyer wallet + seller who mints and flips = WASH TRADE. Say so directly
- Buyer and seller are the same address = WASH TRADE. Say so directly
- Name minted and sold same day or within days at inflated price = WASH TRADE. Say so directly
- Seller has a pattern of minting cheap names and selling them to fresh wallets = WASH TRADE. Say so directly

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
- "name.eth @handle" → use "name.eth @handle"
- "0xabcd...1234" → use "0xabcd...1234"

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
    const { event, tokenInsights, buyerStats, sellerStats, recipientStats, buyerActivityHistory, sellerActivityHistory, recipientActivityHistory, clubInfo, clubContext, activeListings, previousReplies, metadata } = context;

    // Sanitize token name to prevent prompt injection
    const sanitizedTokenName = this.sanitizeLabel(event.tokenName.replace(/\.eth$/i, '')) + '.eth';

    // Format display handles for buyer, seller, and recipient
    const buyerHandle = this.formatDisplayHandle(event.buyerEnsName, event.buyerTwitter, event.buyerAddress);
    const sellerHandle = event.sellerAddress 
      ? this.formatDisplayHandle(event.sellerEnsName, event.sellerTwitter, event.sellerAddress)
      : null;
    const recipientHandle = event.recipientAddress
      ? this.formatDisplayHandle(event.recipientEnsName, event.recipientTwitter, event.recipientAddress)
      : null;

    // Format event details
    let prompt = `EVENT:\n`;
    prompt += `- Type: ${event.type}\n`;

    if (event.type === 'renewal') {
      // Renewals are tx-level: name is the top-by-cost representative; full list is in renewalContext.
      // The "price" here is the TOTAL cost across all names in the tx, not per-name.
      const ctx = context.renewalContext;
      const nameCount = ctx?.nameCount ?? 1;
      if (nameCount === 1) {
        prompt += `- Name: ${sanitizedTokenName}\n`;
      } else {
        prompt += `- Top Name: ${sanitizedTokenName} (representative; full list below)\n`;
        prompt += `- Bulk Renewal: ${nameCount} names in one tx\n`;
      }
      prompt += `- Total Renewal Cost: ${event.price.toFixed(4)} ETH ($${event.priceUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })})\n`;
      prompt += `- Renewer: ${buyerHandle}\n`;

      // Recipient context for renewals: gift renewal / 3rd-party paid on behalf of owner
      if (recipientHandle) {
        prompt += `- Owner of top name: ${recipientHandle} (renewer ≠ owner — gift renewal or 3rd-party renewal service)\n`;
      }
    } else {
      // Existing sale/registration/bid event rendering (unchanged)
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

      // Known account: ENS Fairy (check both buyer/minter and recipient)
      const ensFairyName = 'ensfairy.eth';
      if (event.type === 'registration' && (
        event.buyerEnsName?.toLowerCase() === ensFairyName ||
        event.recipientEnsName?.toLowerCase() === ensFairyName
      )) {
        prompt += `- ℹ️ KNOWN ACCOUNT: ensfairy.eth is a public-good entity that registers names preemptively to gift them to the matching companies/projects before others get them.\n`;
      }

      // Recipient context: when the name was registered to a different wallet
      if (event.type === 'registration' && recipientHandle) {
        prompt += `- Recipient: ${recipientHandle} (${buyerHandle} registered this name to ${recipientHandle}'s wallet)\n`;
      }
    }
    
    // Include category membership if available (sanitized)
    if (clubInfo) {
      const sanitizedClubInfo = this.sanitizeLabel(clubInfo);
      // Pluralize based on comma count (multiple categories)
      const categoryLabel = clubInfo.includes(',') ? 'Categories' : 'Category';
      prompt += `- ${categoryLabel}: ${sanitizedClubInfo}\n`;
    }

    // Include active listing data if available
    if (activeListings && activeListings.length > 0) {
      const sorted = [...activeListings].sort((a, b) => a.price - b.price);
      const lowest = sorted[0];
      const displaySymbol = lowest.currencySymbol === 'WETH' ? 'ETH' : lowest.currencySymbol;
      prompt += `- Listed: ${lowest.price.toFixed(2)} ${displaySymbol}`;
      if (sorted.length > 1) {
        prompt += ` (${sorted.length} listings across marketplaces)`;
      }
      if (lowest.source) {
        prompt += ` [${lowest.source}]`;
      }
      prompt += `\n`;
    }

    // For renewals: render the top-3-by-cost breakdown + the full name list.
    // The image shows the top 3 cards; the LLM gets everything for pattern detection.
    if (event.type === 'renewal' && context.renewalContext) {
      const ctx = context.renewalContext;
      if (ctx.topNames.length > 0 && ctx.nameCount > 1) {
        prompt += `\nRENEWAL BREAKDOWN:\n`;
        prompt += `- Top names by per-name renewal cost (these are the renewer's most valuable holdings in this tx):\n`;
        for (const t of ctx.topNames) {
          prompt += `    ${t.name} — ${t.costEth.toFixed(4)} ETH\n`;
        }
        if (ctx.nameCount > ctx.topNames.length) {
          // Always include the FULL name list for pattern/theme detection.
          // Truncate at a reasonable cap if a tx is absurdly large (e.g., 500+ names)
          // to avoid blowing the context window.
          const maxAllNames = 200;
          const allNamesList = ctx.allNames.slice(0, maxAllNames).join(', ');
          const truncatedNote = ctx.allNames.length > maxAllNames
            ? ` (showing first ${maxAllNames} of ${ctx.allNames.length})`
            : '';
          prompt += `- All ${ctx.nameCount} names renewed in this tx${truncatedNote}:\n    ${allNamesList}\n`;
        }
      }
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

      // Flag re-registrations of expired names
      if (event.type === 'registration' && (tokenInsights.firstTx || tokenInsights.previousTx)) {
        prompt += `- ⚠️ EXPIRED NAME: This is a re-registration. The previous owner let this name expire. There is no seller.\n`;
      }

      // Add ENS registration base price as background context
      if (event.type === 'registration') {
        const label = event.tokenName.replace(/\.eth$/i, '');
        const charCount = [...label].length;
        const basePriceNote = charCount === 3 ? '$640/yr' : charCount === 4 ? '$160/yr' : '$5/yr';
        prompt += `- (background: ENS base price for ${charCount}-char names is ${basePriceNote}, don't lead with this)\n`;
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

    // Recipient sections (only when minter ≠ recipient for registrations)
    if (recipientStats) {
      if (metadata.recipientDataUnavailable) {
        prompt += `\nRECIPIENT STATS: ⚠️ DATA UNAVAILABLE (API error). Activity data could not be fetched.\n`;
      } else {
        prompt += `\nRECIPIENT STATS (${recipientStats.ensName || 'address ' + recipientStats.address.slice(0, 10) + '...'}):\n`;
        prompt += `- Buys: ${recipientStats.buysCount} (${recipientStats.buysVolume.toFixed(4)} ETH / $${recipientStats.buysVolumeUsd.toLocaleString()})\n`;
        prompt += `- Sells: ${recipientStats.sellsCount} (${recipientStats.sellsVolume.toFixed(4)} ETH / $${recipientStats.sellsVolumeUsd.toLocaleString()})\n`;
        prompt += `- Activity: ${recipientStats.transactionsPerMonth.toFixed(1)} txns/month\n`;

        if (recipientStats.biddingStats) {
          const es = recipientStats.biddingStats;
          prompt += `- Bidding activity: ${es.totalBids} bids placed, ${es.totalBidVolume.toFixed(4)} ETH total (avg ${es.averageBidAmount.toFixed(4)} ETH per bid)\n`;
          if (es.bidPatterns.commonThemes.length > 0) {
            prompt += `- Bid themes: ${es.bidPatterns.commonThemes.join(', ')}\n`;
          }
        }

        if (recipientStats.portfolio && recipientStats.portfolio.totalValueUsd >= 100000) {
          const p = recipientStats.portfolio;
          prompt += `\nPORTFOLIO (RECIPIENT):\n`;
          prompt += `- Total value: $${p.totalValueUsd.toLocaleString()}\n`;
          const activeChains = Object.entries(p.crossChainPresence)
            .filter(([_, active]) => active)
            .map(([chain, _]) => chain);
          if (activeChains.length > 1) {
            prompt += `- Cross-chain: ${activeChains.join(', ')}\n`;
          }
        }
      }

      if (!metadata.recipientDataUnavailable && recipientActivityHistory && recipientActivityHistory.length > 0) {
        prompt += `\nRECIPIENT FULL HISTORY (${Math.min(recipientActivityHistory.length, 10)} recent):\n`;
        const recentRecipientActivity = recipientActivityHistory.slice(-10);
        for (const activity of recentRecipientActivity) {
          const date = new Date(activity.timestamp * 1000).toISOString().slice(0, 10);
          const tokenName = activity.tokenName ? activity.tokenName.slice(0, 20) : 'unknown';
          prompt += `- ${date}: ${activity.type} ${tokenName} for ${activity.price.toFixed(4)} ETH [${activity.role}]\n`;
        }
      }

      if (!metadata.recipientDataUnavailable && recipientStats.currentHoldings && recipientStats.currentHoldings.length > 0) {
        prompt += `\nRECIPIENT CURRENT HOLDINGS (${recipientStats.currentHoldings.length} names${recipientStats.holdingsIncomplete ? ' - incomplete data' : ''}):\n`;
        prompt += this.formatHoldingsWithClubs(recipientStats.currentHoldings);
        prompt += `\n`;
      }
    }

    // Previous replies for context (avoid repetition)
    if (previousReplies.recent.length > 0) {
      prompt += `\n--- YOUR RECENT TWEETS (last ${previousReplies.recent.length}) ---\n`;
      prompt += `NOTE: Older tweets may use a different style/format than your current instructions.\n`;
      prompt += `Try to avoid repeating phrasing, structure, or jokes from these. Vary your tone and approach.\n\n`;
      for (const reply of previousReplies.recent) {
        const label = reply.tokenName ? `[${reply.transactionType}: ${reply.tokenName}]` : `[${reply.transactionType}]`;
        prompt += `${label} ${reply.replyText}\n\n`;
      }
    }

    const prevBuyerLabel = event.type === 'registration' ? 'MINTER' : 'BUYER';
    if (previousReplies.buyer.length > 0) {
      prompt += `\n--- PREVIOUS TWEETS ABOUT THIS ${prevBuyerLabel} ---\n`;
      prompt += `You've tweeted about this address before. Reference continuity if interesting, but don't repeat yourself.\n\n`;
      for (const reply of previousReplies.buyer) {
        const label = reply.tokenName ? `[${reply.transactionType}: ${reply.tokenName}]` : `[${reply.transactionType}]`;
        prompt += `${label} ${reply.replyText}\n\n`;
      }
    }

    const prevSellerLabel = event.type === 'bid' ? 'OWNER' : 'SELLER';
    if (event.type !== 'registration' && previousReplies.seller.length > 0) {
      prompt += `\n--- PREVIOUS TWEETS ABOUT THIS ${prevSellerLabel} ---\n`;
      prompt += `You've tweeted about this address before. Reference continuity if interesting, but don't repeat yourself.\n\n`;
      for (const reply of previousReplies.seller) {
        const label = reply.tokenName ? `[${reply.transactionType}: ${reply.tokenName}]` : `[${reply.transactionType}]`;
        prompt += `${label} ${reply.replyText}\n\n`;
      }
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

  // ───────────────────────────────────────────────────────────────────────────
  // Weekly Market Summary (Phase 4)
  // ───────────────────────────────────────────────────────────────────────────
  //
  // Single Responses-API call against the `weekly` model with xhigh reasoning
  // and a strict JSON schema for output. The aggregator
  // (`WeeklySummaryDataService`) hands us a fully populated `WeeklySummaryData`;
  // we serialize it deterministically, prepend a long-form system prompt, and
  // ask the model to return JSON matching `WEEKLY_THREAD_SCHEMA` — five
  // tweets, one per dedicated lane, in fixed order.
  //
  // We never escalate to the o1 thinking model here — the weekly model
  // already has 1.05M context and built-in reasoning. The token estimator and
  // selectModel() machinery used by the per-event reply path is intentionally
  // bypassed; cost matters less than quality on a once-a-week run.
  //
  // We use Structured Outputs (json_schema, strict: true) instead of marker-
  // based parsing because (a) it's API-enforced rather than hoping the model
  // emits the literal separator string, (b) the per-tweet `section` tag lets
  // the dashboard / image template label tweets without inferring from
  // position, and (c) `maxLength` on `text` is enforced server-side.

  /** Twitter Premium+ ceiling for thread tweets. */
  private static readonly WEEKLY_TWEET_MAX_CHARS = 1200;
  /**
   * Hardcoded first line prepended to the headline tweet after parsing.
   * The LLM is told NOT to write its own header (and to budget chars
   * accordingly) — same pattern we use elsewhere in the codebase for the
   * per-event AI replies (where "AI insight:" is auto-prefixed).
   */
  private static readonly WEEKLY_HEADLINE_HEADER = 'This Week in ENS Market (by GrailsAI ✨)';
  /**
   * The five lanes of the weekly thread, in the order they MUST appear.
   * The system prompt + JSON schema both anchor on this ordering; the
   * post-parse validator double-checks it.
   */
  private static readonly WEEKLY_TWEET_ORDER: readonly WeeklyTweetSection[] = [
    'headline',
    'by_the_numbers',
    'spotlight',
    'community_pulse',
    'top_player',
  ] as const;
  /** Pricing (USD per token) for `gpt-5.4-2026-03-05` per OpenAI model card. */
  private static readonly WEEKLY_INPUT_USD_PER_TOKEN = 2.5 / 1_000_000;
  private static readonly WEEKLY_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000;

  /**
   * Strict JSON schema enforcing exactly 5 thread tweets in fixed order. The
   * `section` enum + `tweets` minItems/maxItems make the API itself reject
   * any malformed output. `text` length cap (1200) is enforced server-side
   * too. We still re-validate the order post-parse as defence in depth.
   */
  private static readonly WEEKLY_THREAD_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['tweets'],
    properties: {
      tweets: {
        type: 'array',
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['section', 'text'],
          properties: {
            section: {
              type: 'string',
              enum: ['headline', 'by_the_numbers', 'spotlight', 'community_pulse', 'top_player'],
              description:
                'Which lane this tweet covers. Tweets MUST appear in this exact order: ' +
                'headline, by_the_numbers, spotlight, community_pulse, top_player.',
            },
            text: {
              type: 'string',
              minLength: 1,
              maxLength: 1200,
              description:
                'Final tweet text. Tweet 1 (headline) ideally <280 chars; tweets 2-5 up to 1200.',
            },
          },
        },
      },
    },
  } as const;

  /**
   * Generate the weekly market summary thread.
   *
   * @param data Fully populated `WeeklySummaryData` from the aggregator.
   * @returns Parsed thread tweets (with section tags), model metadata, and
   *   combined LLM cost.
   * @throws if the model output isn't valid JSON, doesn't match the schema,
   *   or returns sections in the wrong order.
   */
  async generateWeeklySummary(data: WeeklySummaryData): Promise<{
    tweets: WeeklyThreadTweet[];
    modelUsed: string;
    promptTokens: number;
    completionTokens: number;
    costUsd: number;
    fullPrompt: string;
  }> {
    const startTime = Date.now();
    logger.info(`📰 Generating weekly summary for ${data.weekStart} → ${data.weekEnd}`);

    const systemPrompt = this.buildWeeklySummarySystemPrompt();
    const userPrompt = this.buildWeeklySummaryUserPrompt(data);
    const fullPrompt = `${systemPrompt}\n\n${userPrompt}`;

    logger.info(
      `📰 Prompt: system=${systemPrompt.length} chars, user=${userPrompt.length} chars, total=${fullPrompt.length} chars`,
    );
    logger.info(
      `📰 Source failures (${data.partialSourceFailures.length}): ${data.partialSourceFailures.join(', ') || 'none'}`,
    );

    // Call the Responses API with retry + an explicit 30-min timeout. Casts:
    //   - `effort: WEEKLY_REASONING_EFFORT as any`: the installed SDK (6.2.0)
    //     types ReasoningEffort up to 'high'; the OpenAI API accepts 'xhigh'
    //     as a higher tier. The constant is currently set to 'low' for testing.
    //   - `schema: ... as any`: SDK types `schema: { [k: string]: unknown }`
    //     which doesn't accept our `readonly` const-asserted literal directly.
    //   - `model` slug `gpt-5.4-2026-03-05` is outside the SDK's `ChatModel`
    //     union but works at runtime (the union allows arbitrary strings).
    //
    // Timeout: per-call override (passed as the 2nd `RequestOptions` arg) —
    // the SDK default 10-min timeout failed to fire on a stuck request
    // during initial testing, so we set it explicitly. 30 min is generous;
    // tighten once the flow is proven.
    logger.info(
      `📰 Calling OpenAI Responses API: model=${this.models.weekly.name} ` +
        `effort=${OpenAIService.WEEKLY_REASONING_EFFORT} ` +
        `timeout=${OpenAIService.WEEKLY_API_TIMEOUT_MS / 1000}s`,
    );
    const response = await this.withRetry(
      async () => {
        return await this.client.responses.create(
          {
            model: this.models.weekly.name,
            input: fullPrompt,
            reasoning: { effort: OpenAIService.WEEKLY_REASONING_EFFORT as any },
            text: {
              format: {
                type: 'json_schema',
                name: 'WeeklySummaryThread',
                strict: true,
                schema: OpenAIService.WEEKLY_THREAD_SCHEMA as any,
              },
            },
          },
          { timeout: OpenAIService.WEEKLY_API_TIMEOUT_MS },
        );
      },
      `Weekly summary generation (window ${data.weekStart} → ${data.weekEnd})`,
    );

    const rawText = response.output_text?.trim() || '';
    if (!rawText) {
      throw new Error('Weekly summary: model returned empty output');
    }

    const tweets = this.parseAndValidateWeeklyTweets(rawText);

    const usage = response.usage;
    const promptTokens = usage?.input_tokens || 0;
    const completionTokens = usage?.output_tokens || 0;
    const costUsd =
      promptTokens * OpenAIService.WEEKLY_INPUT_USD_PER_TOKEN +
      completionTokens * OpenAIService.WEEKLY_OUTPUT_USD_PER_TOKEN;

    const elapsedMs = Date.now() - startTime;
    logger.info(
      `📰 Weekly summary generated in ${elapsedMs}ms — ${tweets.length} tweet(s), ` +
        `${promptTokens.toLocaleString()} input + ${completionTokens.toLocaleString()} output tokens, ` +
        `cost ~$${costUsd.toFixed(3)}`,
    );

    return {
      tweets,
      modelUsed: response.model,
      promptTokens,
      completionTokens,
      costUsd,
      fullPrompt,
    };
  }

  /**
   * Parse the JSON-schema response and validate that:
   *   - It's parseable JSON with a `tweets` array
   *   - Exactly 5 items
   *   - Sections appear in the canonical order (headline → by_the_numbers →
   *     spotlight → community_pulse → top_player)
   *   - Each `text` is non-empty and within the Premium+ char ceiling
   *
   * Most of these are also enforced by the API via `strict: true`, but we
   * re-validate as defence in depth — if the model ever returns a payload
   * that bypasses the schema (or a future SDK upgrade silently relaxes
   * `strict`), we fail loudly here instead of posting garbage.
   */
  private parseAndValidateWeeklyTweets(rawText: string): WeeklyThreadTweet[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err: any) {
      throw new Error(`Weekly summary: model output is not valid JSON: ${err.message}`);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Weekly summary: model output is not a JSON object');
    }

    const tweetsRaw = (parsed as any).tweets;
    if (!Array.isArray(tweetsRaw)) {
      throw new Error('Weekly summary: model output is missing the "tweets" array');
    }

    const expectedOrder = OpenAIService.WEEKLY_TWEET_ORDER;
    if (tweetsRaw.length !== expectedOrder.length) {
      throw new Error(
        `Weekly summary: expected exactly ${expectedOrder.length} tweets, got ${tweetsRaw.length}`,
      );
    }

    const tweets: WeeklyThreadTweet[] = [];
    for (let i = 0; i < tweetsRaw.length; i++) {
      const item = tweetsRaw[i];
      if (typeof item !== 'object' || item === null) {
        throw new Error(`Weekly summary tweet ${i + 1}: not an object`);
      }
      const section = (item as any).section;
      const text = (item as any).text;

      if (typeof section !== 'string' || !expectedOrder.includes(section as WeeklyTweetSection)) {
        throw new Error(
          `Weekly summary tweet ${i + 1}: invalid section "${section}" (allowed: ${expectedOrder.join(', ')})`,
        );
      }
      if (section !== expectedOrder[i]) {
        throw new Error(
          `Weekly summary tweet ${i + 1}: section out of order — got "${section}", expected "${expectedOrder[i]}"`,
        );
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw new Error(`Weekly summary tweet ${i + 1}: text is empty`);
      }
      if (text.length > OpenAIService.WEEKLY_TWEET_MAX_CHARS) {
        throw new Error(
          `Weekly summary tweet ${i + 1} (${section}): text exceeds ` +
            `${OpenAIService.WEEKLY_TWEET_MAX_CHARS} chars (actual: ${text.length}). Premium+ ceiling.`,
        );
      }

      tweets.push({ section: section as WeeklyTweetSection, text });
    }

    // Apply the hardcoded headline header. The system prompt tells the model
    // NOT to write its own header (and to budget the tweet 1 character count
    // accordingly), so we prepend ours here. Same pattern as the per-event AI
    // reply pipeline ("AI insight:" prefix). Single literal newline keeps the
    // header on its own line followed immediately by the model's text.
    const headlineIdx = tweets.findIndex(t => t.section === 'headline');
    if (headlineIdx !== -1) {
      tweets[headlineIdx] = {
        section: 'headline',
        text: `${OpenAIService.WEEKLY_HEADLINE_HEADER}\n\n${tweets[headlineIdx].text}`,
      };
    }

    return tweets;
  }

  /**
   * Long-form system prompt for the weekly summary. Establishes voice
   * continuity with the per-event AI replies, defines the 5-tweet thread
   * shape (each lane has a dedicated job), and lays out framing rules for
   * the spotlight, Top Player, wash data, week-over-week deltas, etc.
   *
   * Output format is enforced by the JSON schema in WEEKLY_THREAD_SCHEMA;
   * this prompt re-states the structure so the model has explicit guidance
   * for what each lane is for.
   */
  private buildWeeklySummarySystemPrompt(): string {
    return `You are GrailsAI Weekly — a sharp, opinionated ENS market analyst writing the weekly recap thread for the ENS community on X. You look back over the past 7 days, find the real story, and tell it tight.

YOUR TASK:
Write a 5-tweet thread following the strict JSON schema you've been given. Each tweet has a dedicated lane — they are NOT interchangeable. Together they form a clear arc: pulse → numbers → forward → community → personality.

OUTPUT FORMAT:
Return JSON: { "tweets": [ { "section": "...", "text": "..." }, ... ] } with EXACTLY 5 entries in this order:

  1. section "headline"          → punchy lead-in
  2. section "by_the_numbers"    → hard data
  3. section "spotlight"         → dynamic deep-focus
  4. section "community_pulse"   → broad sentiment
  5. section "top_player"        → climactic actor reveal

Each \`text\` field must be ≤ 1200 characters. The schema enforces this server-side; do not exceed it.

DO NOT number tweets ("1/", "2/"). DO NOT add a TL;DR. DO NOT use dashes (—, –, or - at start of lines). Use periods, commas, short paragraphs.

══════════════════════════════════════════════════════════════════════════
TWEET 1 — section: "headline"
══════════════════════════════════════════════════════════════════════════
The single most interesting take of the week. Could be a trend, a whale, a market shift, a wash-trade pattern, a category waking up — whatever the data screams loudest about. Pick ONE angle and go hard.

DO NOT write a header line. The string "${OpenAIService.WEEKLY_HEADLINE_HEADER}" plus a blank line will be prepended to your tweet automatically — your "text" field should contain ONLY your headline take, no header. Aim for under 240 characters in your text so the final tweet (with our header) renders under Twitter's 280-char default limit. Punchy, opinionated, leaves the reader wanting tweet 2.

══════════════════════════════════════════════════════════════════════════
TWEET 2 — section: "by_the_numbers"
══════════════════════════════════════════════════════════════════════════
The hard-data tweet. The headline numbers a market watcher needs to know:

  - Sales: count + total volume (ETH and USD)
  - Registrations/renewals: count + total cost + total premium paid
  - Bids/offers: how active was the bid layer
  - Week-over-week delta on the BIGGEST mover (use PREVIOUS WEEK SNAPSHOT if provided; skip the comparison entirely if it isn't)
  - ETH price context if move is ≥5% AND how it may effect sentiment.

Be selective — don't list every number you have. Surface 4-6 numbers that actually matter. Numbers prefer specificity ("47 ETH across 23 sales" > "lots of activity"). Round USD to nice units ($14k, $1.2M).

══════════════════════════════════════════════════════════════════════════
TWEET 3 — section: "spotlight"
══════════════════════════════════════════════════════════════════════════
The dynamic deep-focus tweet. Pick ONE angle from the menu below — whichever is loudest in the week's data — and go DEEP on it. ONE thing, well-explored.

DEFAULT angle: NAMES TO WATCH. Use the data in NAMES TO WATCH: PREMIUM DECAY (top names with high watcher concentration in the premium auction phase) and NAMES TO WATCH: GRACE → PREMIUM SOON (names dropping into the premium auction within 7 days if current owner doesn't renew). Lead with premium-decay names — that's where the auction action is happening this week. Mention 1-2 grace-soon names as a tail ("and watching these enter the auction this week:").

PIVOT angles (use INSTEAD of names-to-watch only if clearly louder):
  - ENGAGING POST OF YOURS: One of YOUR OWN posts from earlier this week drove unusually high engagement or a juicy reply thread. Lead with what you said and why it landed. Reference the actual replies for context (PARAPHRASE — never quote verbatim).
  - CATEGORY HEATING UP: 2+ of the week's top sales or registrations share a club tag (999 club, 10k club, 3-letter, prepunks, etc.). Identify the cluster and what it means.
  - NOTABLE SINGLE TRADE: One individual sale or registration is genuinely the story of the week — a steal, a wash, an absurd overpay, a name with a backstory. Different from the headline insight (which is broader).

Whatever you pick, go DEEP — give the reader specifics, numbers, names. Don't list multiple angles. ONE thing.

══════════════════════════════════════════════════════════════════════════
TWEET 4 — section: "community_pulse"
══════════════════════════════════════════════════════════════════════════
Broad sentiment sweep. Zoom OUT (vs tweet 3 which goes deep on one thing). Aggregate themes across:

  - ENS CHATTER: themes from broad ENS-related tweets in the past 7d. Common topics, narrative threads, vibe shifts.
  - YOUR OWN ENGAGEMENT: which kinds of YOUR posts are landing this week (which categories of sale/reg/bid drove the most engagement), without repeating any specific post you already covered in tweet 3.
  - Notable accounts mentioning ENS or relevant news/launches if surfaced in chatter.

NEVER quote third-party tweets verbatim. PARAPHRASE community sentiment, never reproduce it.

══════════════════════════════════════════════════════════════════════════
TWEET 5 — section: "top_player"
══════════════════════════════════════════════════════════════════════════
Climactic actor reveal. Lead with the literal phrase "Top Player of the Week:" followed by the address handle (their ENS name if they have one, otherwise a short address like 0xabcd…1234).

Then 2-4 sentences explaining what they did this week. Reference TOP PARTICIPANTS data — full breakdown of buys / sells / registrations / renewals with actual ETH amounts. Pick the address with the most interesting STORY given the rest of the week's context — it does NOT have to be #1 by volume. The math gave you the top 3 candidates from OUR DATABASE.

══════════════════════════════════════════════════════════════════════════
GENERAL FRAMING RULES
══════════════════════════════════════════════════════════════════════════

WASH-TRADE DATA: You'll see WASH SIGNALS — sales involving blacklisted addresses, plus AI replies that mentioned "wash" this week. NEITHER is a verdict — they're inputs. Surface in tweet 1 if washes were a meaningful share of volume; footnote in tweet 3 spotlight if there's a notable single wash; otherwise skip.

WEEK-OVER-WEEK: If PREVIOUS WEEK SNAPSHOT is present, use deltas in tweet 2 ("volume +40% w/w"). If NOT present, skip the comparison angle entirely — DO NOT say "no comparison available".

PARTIAL SOURCE FAILURES: If a section is listed as failed, work without it. NEVER fabricate numbers to fill gaps.

WRITING STYLE:
- Short, punchy sentences. Get to the point fast.
- Be confident. No hedging. "Volume cratered 40% week-on-week" not "volume seems to have decreased somewhat".
- Mock gently when warranted: "67 names renewed in one tx by an address that's never sold. Call it conviction or call it indecision."
- Highlight steals and overpays with actual numbers.
- Humor comes from data contrasts, not forced jokes.
- Use "onchain" not "on-chain", "multichain" not "multi-chain".
- ETH values: 2 decimals max for ≥0.01 ETH, more precision only for tiny values.
- USD: rounded ($14k, $1.2M, $850).
- Avoid: "scooped up", "snapped up", "nabbed", "on a tear", emojis (the ✨ in the auto-prepended tweet 1 header is the only one — your text fields should contain none).

CONTINUOUS IDENTITY:
You are GrailsAI Weekly. The data you'll see under YOUR PAST POSTS, YOUR OWN TWEET ENGAGEMENT, and THIRD-PARTY REPLIES is YOUR OWN past output and the engagement on it — NOT some external bot's. Speak in first person. Use "we" or "I" when referencing past takes ("we covered this on Tuesday", "our take on the X sale aged well"). NEVER refer to yourself as "the bot" or "the AI" in third person — that breaks the voice.

CRITICAL RULES:
- NEVER fabricate numbers. If a section is missing, work without it.
- NEVER quote third-party tweets verbatim.
- NEVER use the word "edgy". NEVER use "rather than", "instead of", "as opposed to".
- NEVER mention legal / trademark / IP / copyright issues.
- NEVER mention the absence of something ("no wash trades", "no notable whales").
- NEVER apologise for missing data. State what you have and move on.
- NEVER ask questions. You're writing a recap, not a survey.

Each tweet stands on its own — a reader who only sees tweet 1 should still get value. Tweets 2-5 build context, detail, sentiment, and the actor reveal.`;
  }

  /**
   * Serialize `WeeklySummaryData` into a plain-text user prompt with clear
   * section headers. We do NOT truncate self-tweets, AI replies, or third-party
   * replies — the LLM gets everything raw. We DO truncate enormous arrays
   * (e.g., 50 premium watchers) only by limit at the source level (already
   * capped by the aggregator's TUNABLES).
   *
   * Sections appear in roughly priority order so the model reads the most
   * important context first if it has to make decisions about what to surface.
   */
  private buildWeeklySummaryUserPrompt(data: WeeklySummaryData): string {
    const lines: string[] = [];

    lines.push(`WEEK WINDOW: ${data.weekStart}  →  ${data.weekEnd}`);
    lines.push('');

    // ── Source failure honesty ───────────────────────────────────────────────
    if (data.partialSourceFailures.length > 0) {
      lines.push(`PARTIAL SOURCE FAILURES (${data.partialSourceFailures.length}):`);
      lines.push(`  ${data.partialSourceFailures.join(', ')}`);
      lines.push('  → Treat these sections as missing; do not fabricate numbers.');
      lines.push('');
    }

    // ── ETH price context ────────────────────────────────────────────────────
    lines.push('ETH PRICE:');
    if (data.ethPriceNow !== null) {
      lines.push(`  Now:        $${data.ethPriceNow.toFixed(2)}`);
    } else {
      lines.push(`  Now:        unavailable`);
    }
    if (data.ethPrice7dAgo !== null) {
      lines.push(`  7d ago:     $${data.ethPrice7dAgo.toFixed(2)}`);
      if (data.ethPriceNow !== null) {
        const delta = data.ethPriceNow - data.ethPrice7dAgo;
        const pct = (delta / data.ethPrice7dAgo) * 100;
        const sign = delta >= 0 ? '+' : '';
        lines.push(`  Change:     ${sign}$${delta.toFixed(2)} (${sign}${pct.toFixed(1)}%)`);
      }
    } else {
      lines.push(`  7d ago:     unavailable`);
    }
    lines.push('');

    // ── Market overview (Grails) ─────────────────────────────────────────────
    if (data.marketAnalytics) {
      const m = data.marketAnalytics;
      lines.push('MARKET OVERVIEW (7d, from Grails):');
      lines.push(`  Total names:        ${m.overview.total_names.toLocaleString()}`);
      lines.push(`  Active listings:    ${m.overview.active_listings.toLocaleString()}`);
      lines.push(`  Active offers:      ${m.overview.active_offers.toLocaleString()}`);
      lines.push(`  Total watchers:     ${m.overview.total_watchers.toLocaleString()}`);
      lines.push(`  Total views:        ${m.overview.total_views.toLocaleString()}`);
      lines.push('');
      lines.push(`  Sales count:        ${m.volume.sales_count.toLocaleString()}`);
      lines.push(`  Total volume:       ${weiToEth(m.volume.total_volume_wei)} ETH`);
      lines.push(`  Avg sale price:     ${weiToEth(m.volume.avg_sale_price_wei)} ETH`);
      lines.push(`  Max sale price:     ${weiToEth(m.volume.max_sale_price_wei)} ETH`);
      lines.push(`  Min sale price:     ${weiToEth(m.volume.min_sale_price_wei)} ETH`);
      lines.push(`  Unique names sold:  ${m.volume.unique_names_sold.toLocaleString()}`);
      lines.push(`  Unique buyers:      ${m.volume.unique_buyers.toLocaleString()}`);
      lines.push(`  Unique sellers:     ${m.volume.unique_sellers.toLocaleString()}`);
      lines.push('');
      lines.push(`  Activity (7d): ${m.activity.views.toLocaleString()} views, ${m.activity.watchlist_adds.toLocaleString()} watchlist adds, ${m.activity.offers.toLocaleString()} offers, ${m.activity.listings.toLocaleString()} listings`);
      lines.push('');
    }

    // ── Registration analytics ───────────────────────────────────────────────
    if (data.registrationAnalytics) {
      const r = data.registrationAnalytics.summary;
      lines.push('REGISTRATIONS (7d, from Grails):');
      lines.push(`  Total count:           ${r.registration_count.toLocaleString()}`);
      lines.push(`  Total cost:            ${weiToEth(r.total_cost_wei)} ETH`);
      lines.push(`  Total base cost:       ${weiToEth(r.total_base_cost_wei)} ETH`);
      lines.push(`  Total premium:         ${weiToEth(r.total_premium_wei)} ETH`);
      lines.push(`  Avg cost:              ${weiToEth(r.avg_cost_wei)} ETH`);
      lines.push(`  Premium registrations: ${r.premium_registrations.toLocaleString()} (${pct(r.premium_registrations, r.registration_count)})`);
      lines.push(`  Unique registrants:    ${r.unique_registrants.toLocaleString()}`);

      const byLen = data.registrationAnalytics.by_length;
      if (byLen.length > 0) {
        lines.push('  By name length (count, total cost ETH):');
        for (const b of byLen) {
          lines.push(`    ${String(b.name_length).padStart(2)}-char: ${String(b.count).padStart(5)}  total ${weiToEth(b.total_cost_wei).padStart(8)} ETH`);
        }
      }
      lines.push('');
    }

    // ── Self-DB renewals stats (Grails has none) ─────────────────────────────
    lines.push('RENEWAL STATS (7d, from our DB — Grails has no renewal endpoints):');
    lines.push(`  Names renewed:         ${data.renewalsStats.count.toLocaleString()}`);
    lines.push(`  Distinct transactions: ${data.renewalsStats.txCount.toLocaleString()}`);
    lines.push(`  Total volume:          ${data.renewalsStats.totalVolumeEth.toFixed(4)} ETH (${fmtUsd(data.renewalsStats.totalVolumeUsd)})`);
    if (data.renewalsStats.topByVolume.length > 0) {
      lines.push(`  Top renewals by per-name cost (top ${data.renewalsStats.topByVolume.length}):`);
      for (const r of data.renewalsStats.topByVolume) {
        const eth = r.costEth ? Number(r.costEth).toFixed(4) : '?';
        const usd = r.costUsd ? fmtUsd(Number(r.costUsd)) : '?';
        lines.push(`    ${r.fullName} — ${eth} ETH (${usd}) — renewer ${shortAddrLocal(r.renewerAddress)}`);
      }
    }
    lines.push('');

    // ── Top Player of the Week candidates ────────────────────────────────────
    // The math gave us the top 3 by combined volume; the prompt instructs the
    // model to pick the most INTERESTING story from these, not necessarily #1.
    if (data.topParticipants.length > 0) {
      lines.push(`TOP PLAYER OF THE WEEK CANDIDATES (top ${data.topParticipants.length} by combined ETH volume across buys+sells+regs+renewals; from our DB only):`);
      data.topParticipants.forEach((p, idx) => {
        lines.push(this.formatTopParticipant(p, idx + 1));
      });
      lines.push('  ↑ For tweet 5: pick the most interesting story from above — does NOT have to be #1.');
      lines.push('');
    }

    // ── Wash signals ─────────────────────────────────────────────────────────
    lines.push('WASH SIGNALS (7d, raw — surface only if meaningful):');
    lines.push(`  Blacklisted-address sales: ${data.washSignals.blacklistMatches.count.toLocaleString()}, volume ${data.washSignals.blacklistMatches.volumeEth.toFixed(4)} ETH (${fmtUsd(data.washSignals.blacklistMatches.volumeUsd)})`);
    lines.push(`  AI replies mentioning 'wash': ${data.washSignals.aiReplyWashMentions.count.toLocaleString()}`);
    if (data.washSignals.blacklistMatches.sales.length > 0) {
      lines.push(`  Sample blacklist sales (first ${data.washSignals.blacklistMatches.sales.length}):`);
      for (const s of data.washSignals.blacklistMatches.sales.slice(0, 5)) {
        const name = s.nftName || `#${s.tokenId?.slice(0, 8)}`;
        const eth = s.priceAmount ? Number(s.priceAmount).toFixed(4) : '?';
        const usd = s.priceUsd ? fmtUsd(Number(s.priceUsd)) : '?';
        lines.push(`    ${name} — ${eth} ETH (${usd}) — buyer ${shortAddrLocal(s.buyerAddress)}, seller ${shortAddrLocal(s.sellerAddress)}`);
      }
    }
    lines.push('');

    // ── Top sales (Grails) ───────────────────────────────────────────────────
    if (data.topSales.length > 0) {
      lines.push(`TOP SALES (7d, top ${data.topSales.length} by price, from Grails):`);
      for (const s of data.topSales) {
        const eth = weiToEth(s.sale_price_wei);
        const clubs = s.clubs && s.clubs.length > 0 ? `  [${s.clubs.join(', ')}]` : '';
        lines.push(`  ${s.name} — ${eth} ETH — buyer ${shortAddrLocal(s.buyer_address)}, seller ${shortAddrLocal(s.seller_address)}, on ${s.source ?? 'unknown'}${clubs}`);
      }
      lines.push('');
    }

    // ── Top registrations (Grails) ───────────────────────────────────────────
    if (data.topRegistrations.length > 0) {
      lines.push(`TOP REGISTRATIONS (7d, top ${data.topRegistrations.length} by cost; premium drops surface here naturally):`);
      for (const r of data.topRegistrations) {
        const total = weiToEth(r.total_cost_wei);
        const premium = weiToEth(r.premium_wei);
        const clubs = r.clubs && r.clubs.length > 0 ? `  [${r.clubs.join(', ')}]` : '';
        lines.push(`  ${r.name} — ${total} ETH total (${premium} ETH premium) — registrant ${shortAddrLocal(r.registrant_address)}${clubs}`);
      }
      lines.push('');
    }

    // ── Top offers (Grails) ──────────────────────────────────────────────────
    if (data.topOffers.length > 0) {
      lines.push(`TOP OFFERS (7d, top ${data.topOffers.length} by amount):`);
      for (const o of data.topOffers) {
        const amt = weiToEth(o.offer_amount_wei);
        const clubs = o.clubs && o.clubs.length > 0 ? `  [${o.clubs.join(', ')}]` : '';
        lines.push(`  ${o.name} — ${amt} ETH (${o.status}) — bidder ${shortAddrLocal(o.buyer_address)}, on ${o.source ?? 'unknown'}${clubs}`);
      }
      lines.push('');
    }

    // ── Volume distribution by price bucket ──────────────────────────────────
    if (data.volumeDistribution && data.volumeDistribution.distribution.length > 0) {
      lines.push('VOLUME DISTRIBUTION (7d, sales count + total ETH volume by price bucket):');
      for (const b of data.volumeDistribution.distribution) {
        lines.push(`  ${b.price_range.padEnd(14)}  ${String(b.sales_count).padStart(4)} sale(s)  ${weiToEth(b.total_volume_wei)} ETH`);
      }
      lines.push('');
    }

    // ── Daily volume + sales charts (compact) ────────────────────────────────
    if (data.volumeChart && data.volumeChart.points.length > 0) {
      lines.push('DAILY VOLUME (7d, ETH per day):');
      for (const p of data.volumeChart.points) {
        lines.push(`  ${p.date.slice(0, 10)}  ${weiToEth(p.total)} ETH`);
      }
      lines.push('');
    }
    if (data.salesChart && data.salesChart.points.length > 0) {
      lines.push('DAILY SALES (7d, count per day):');
      for (const p of data.salesChart.points) {
        lines.push(`  ${p.date.slice(0, 10)}  ${String(p.total).padStart(4)} sale(s)`);
      }
      lines.push('');
    }

    // ── Names to watch — primary input for the spotlight (tweet 3) ───────────
    // Premium-decay names are weighted 80% (the auction action is happening
    // here NOW), grace-soon names are weighted 20% (they enter the auction
    // within 7 days). We surface premium prominently and grace as a tail.
    if (data.premiumByWatchers.length > 0) {
      lines.push(`NAMES TO WATCH: PREMIUM DECAY (top ${Math.min(25, data.premiumByWatchers.length)} by watcher count — auction is live, registrants competing):`);
      for (const n of data.premiumByWatchers.slice(0, 25)) {
        const clubs = n.clubs && n.clubs.length > 0 ? `  [${n.clubs.join(', ')}]` : '';
        lines.push(`  ${n.name} — ${n.watchers_count} watcher(s), expired ${n.expiry_date.slice(0, 10)}${clubs}`);
      }
      lines.push('');
    }
    if (data.graceByWatchers.length > 0) {
      // Grace list is already pre-filtered by the aggregator to names that
      // enter premium auction within 7 days (expiry 83-90 days ago).
      lines.push(`NAMES TO WATCH: GRACE → PREMIUM SOON (top ${Math.min(10, data.graceByWatchers.length)} by watcher count — these enter the premium auction within ~7 days):`);
      for (const n of data.graceByWatchers.slice(0, 10)) {
        const clubs = n.clubs && n.clubs.length > 0 ? `  [${n.clubs.join(', ')}]` : '';
        lines.push(`  ${n.name} — ${n.watchers_count} watcher(s), expired ${n.expiry_date.slice(0, 10)}${clubs}`);
      }
      lines.push('');
    }

    // ── Previous week snapshot for week-over-week comparison ────────────────
    if (data.previousSnapshot) {
      lines.push('PREVIOUS WEEK SNAPSHOT (for week-over-week comparison):');
      lines.push(this.formatPreviousSnapshot(data.previousSnapshot));
      lines.push('');
    } else {
      lines.push('PREVIOUS WEEK SNAPSHOT: not available (first run, or last week\'s post failed). Skip the week-over-week angle entirely — do not mention it.');
      lines.push('');
    }

    // ── Your own posted tweets + AI replies from this week (RAW) ────────────
    // Framed as "yours" rather than "the bot's" — the LLM IS GrailsAI Weekly
    // and these are its own past posts. Continuous identity matters for voice.
    if (data.botPosts.length > 0) {
      lines.push(`YOUR PAST POSTS — your own posted tweets + AI replies from this week, RAW (${data.botPosts.length} item(s), newest first):`);
      for (const p of data.botPosts) {
        lines.push(this.formatBotPost(p));
      }
      lines.push('');
    }

    // ── Twitter engagement metrics on your own tweets ────────────────────────
    if (data.ownTweetsWithFreshMetrics.length > 0) {
      lines.push(`YOUR OWN TWEET ENGAGEMENT (${data.ownTweetsWithFreshMetrics.length} of your tweets with fresh metrics):`);
      // Sort by impressions desc to surface the highest-engagement ones first.
      const sorted = [...data.ownTweetsWithFreshMetrics].sort((a, b) => {
        const ai = a.public_metrics?.impression_count ?? 0;
        const bi = b.public_metrics?.impression_count ?? 0;
        return bi - ai;
      });
      // Cap to the top 25 for token sanity; the LLM only needs the engagement
      // distribution shape, not every single tweet's metrics.
      for (const t of sorted.slice(0, 25)) {
        const m = t.public_metrics;
        if (!m) continue;
        const created = t.created_at ? t.created_at.slice(0, 10) : '?';
        lines.push(`  [${created}] ${m.impression_count.toLocaleString()} imp, ${m.like_count} likes, ${m.reply_count} replies, ${m.retweet_count} RT, ${m.quote_count} quotes — id ${t.id}`);
      }
      lines.push('');
    }

    // ── Third-party replies on your tweets (RAW) ─────────────────────────────
    if (data.thirdPartyReplies.length > 0) {
      const totalReplies = data.thirdPartyReplies.reduce((acc, c) => acc + c.replies.length, 0);
      lines.push(`THIRD-PARTY REPLIES — actual reply text from other accounts to YOUR posts (${data.thirdPartyReplies.length} engaged conv(s), ${totalReplies} repl(ies) total):`);
      for (const conv of data.thirdPartyReplies) {
        lines.push(`  Conversation ${conv.conversationId} (${conv.replies.length} repl(ies)):`);
        for (const r of conv.replies) {
          // Compress text to a single line to keep the prompt readable.
          const text = (r.text ?? '').replace(/\s+/g, ' ').trim();
          if (text.length === 0) continue;
          lines.push(`    "${text}"`);
        }
      }
      lines.push('');
    }

    // ── Broad ENS Twitter chatter ────────────────────────────────────────────
    if (data.ensTwitterChatter.length > 0) {
      lines.push(`ENS CHATTER (${data.ensTwitterChatter.length} broad ENS tweets from past 7d, raw — for sentiment/themes context only, do not quote verbatim or @-mention):`);
      for (const t of data.ensTwitterChatter) {
        const text = (t.text ?? '').replace(/\s+/g, ' ').trim();
        if (text.length === 0) continue;
        lines.push(`  "${text}"`);
      }
      lines.push('');
    }

    // ── Final reminder ───────────────────────────────────────────────────────
    lines.push('---');
    lines.push(`Now write the thread. Return JSON matching the WeeklySummaryThread schema: exactly 5 tweets, in order: headline → by_the_numbers → spotlight → community_pulse → top_player. Tweet 1 (headline): aim for <240 chars in your text — the literal header "${OpenAIService.WEEKLY_HEADLINE_HEADER}" plus a blank line will be auto-prepended, so do NOT write a header yourself. Tweets 2-5 max ${OpenAIService.WEEKLY_TWEET_MAX_CHARS} chars each. Tweet 5 leads with the literal phrase "Top Player of the Week:" followed by the chosen handle. No numbering, no TL;DR, no @-mentions of third-party accounts. Speak in first person — you are GrailsAI Weekly; the past posts you'll see are yours.`);

    return lines.join('\n');
  }

  /**
   * Format one top participant entry — multi-line with per-bucket breakdown.
   */
  private formatTopParticipant(p: WeeklyTopParticipant, rank: number): string {
    const lines: string[] = [];
    const ensLabel = p.ensName ? ` (${p.ensName})` : '';
    lines.push(`  #${rank}: ${shortAddrLocal(p.address)}${ensLabel}  — total ${p.totalEth.toFixed(4)} ETH (${fmtUsd(p.totalUsd)})`);
    if (p.buys.count > 0) lines.push(`     Buys:  ${p.buys.count} for ${p.buys.volumeEth.toFixed(4)} ETH (${fmtUsd(p.buys.volumeUsd)})`);
    if (p.sells.count > 0) lines.push(`     Sells: ${p.sells.count} for ${p.sells.volumeEth.toFixed(4)} ETH (${fmtUsd(p.sells.volumeUsd)})`);
    if (p.registrations.count > 0) lines.push(`     Regs:  ${p.registrations.count} for ${p.registrations.costEth.toFixed(4)} ETH (${fmtUsd(p.registrations.costUsd)})`);
    if (p.renewals.count > 0) lines.push(`     Renews: ${p.renewals.count} for ${p.renewals.costEth.toFixed(4)} ETH (${fmtUsd(p.renewals.costUsd)})`);
    return lines.join('\n');
  }

  /**
   * Format one of your past-post entries (a tweet you posted earlier this week
   * — sale/registration/bid/renewal tweet, or an AI reply). RAW text, no
   * compression. The "you" framing is intentional: from the LLM's POV these
   * are its own past posts, not some external bot's.
   */
  private formatBotPost(p: WeeklyBotPost): string {
    const date = p.postedAt.slice(0, 10);
    const tag = `[${date} ${p.type.toUpperCase()}${p.tweetId ? ` id=${p.tweetId}` : ''}]`;
    return `  ${tag} ${p.text}`;
  }

  /**
   * Format the previous-week snapshot for week-over-week deltas. The model
   * does the actual delta math; we just present both weeks' headline numbers
   * side-by-side in a deterministic shape.
   */
  private formatPreviousSnapshot(s: WeeklySnapshotData): string {
    const lines: string[] = [];
    lines.push(`  Window:                ${s.weekStart} → ${s.weekEnd}`);
    lines.push(`  Sales count:           ${s.salesCount.toLocaleString()}`);
    lines.push(`  Sales volume:          ${s.salesVolumeEth.toFixed(4)} ETH (${fmtUsd(s.salesVolumeUsd)})`);
    lines.push(`  Unique buyers:         ${s.uniqueBuyers.toLocaleString()}`);
    lines.push(`  Unique sellers:        ${s.uniqueSellers.toLocaleString()}`);
    lines.push(`  Unique names sold:     ${s.uniqueNamesSold.toLocaleString()}`);
    lines.push(`  Registrations:         ${s.registrationCount.toLocaleString()} for ${s.registrationCostEth.toFixed(4)} ETH (${fmtUsd(s.registrationCostUsd)})`);
    lines.push(`  Premium regs:          ${s.premiumRegistrations.toLocaleString()}`);
    lines.push(`  Unique registrants:    ${s.uniqueRegistrants.toLocaleString()}`);
    lines.push(`  Renewals:              ${s.renewalCount.toLocaleString()} (${s.renewalTxCount.toLocaleString()} tx) for ${s.renewalVolumeEth.toFixed(4)} ETH (${fmtUsd(s.renewalVolumeUsd)})`);
    lines.push(`  Offers:                ${s.offersCount.toLocaleString()}`);
    lines.push(`  Active listings:       ${s.activeListings.toLocaleString()}`);
    lines.push(`  Active offers:         ${s.activeOffers.toLocaleString()}`);
    if (s.ethPriceUsd !== null) lines.push(`  ETH price (week end):  $${s.ethPriceUsd.toFixed(2)}`);
    return lines.join('\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-private helpers used by the weekly-summary prompt builder.
// Kept at module scope (vs. private static) so they don't widen the class API
// surface; they're pure formatting utilities tied to the wei/USD/address
// conventions of the user prompt.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a wei value (decimal string per Grails responses) to an ETH string
 * with 4 decimals. Returns "?" on parse failure.
 */
function weiToEth(wei: string | number | null | undefined): string {
  if (wei === null || wei === undefined) return '?';
  try {
    // Use BigInt for the integer division to avoid losing precision on huge wei
    // values, then convert the remainder to a decimal portion.
    const bi = typeof wei === 'string' ? BigInt(wei.split('.')[0]) : BigInt(Math.floor(Number(wei)));
    const eth = Number(bi) / 1e18;
    return eth.toFixed(4);
  } catch {
    return '?';
  }
}

function fmtUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '$?';
  if (usd === 0) return '$0';
  return `$${usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function pct(num: number, denom: number): string {
  if (!denom || !Number.isFinite(num / denom)) return '?%';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

function shortAddrLocal(addr: string | null | undefined): string {
  if (!addr) return '<unknown>';
  if (addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

