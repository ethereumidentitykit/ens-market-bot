/**
 * API Toggle Service - Manages master API toggle states
 * Services check this before making external API calls
 */
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';

export interface APIToggleState {
  twitterEnabled: boolean;
  moralisEnabled: boolean;
  magicEdenEnabled: boolean;
  openaiEnabled: boolean;
  autoPostingEnabled: boolean;
  aiAutoPostingEnabled: boolean;
}

export class APIToggleService {
  private static instance: APIToggleService;
  private state: APIToggleState = {
    twitterEnabled: true,
    moralisEnabled: true,
    magicEdenEnabled: true,
    openaiEnabled: true,
    autoPostingEnabled: false,
    aiAutoPostingEnabled: false
  };
  private dbService: IDatabaseService | null = null;
  private initialized = false;

  private constructor() {}

  static getInstance(): APIToggleService {
    if (!APIToggleService.instance) {
      APIToggleService.instance = new APIToggleService();
    }
    return APIToggleService.instance;
  }

  /**
   * Initialize the service with database connection
   */
  async initialize(dbService: IDatabaseService): Promise<void> {
    this.dbService = dbService;
    await this.loadFromDatabase();
    this.initialized = true;
    logger.info('APIToggleService initialized with database persistence');
  }

  /**
   * Load toggle states from database
   */
  private async loadFromDatabase(): Promise<void> {
    if (!this.dbService) return;

    try {
      // Load each toggle state from system_state table
      const twitterState = await this.dbService.getSystemState('api_toggle_twitter');
      const moralisState = await this.dbService.getSystemState('api_toggle_moralis');
      const magicEdenState = await this.dbService.getSystemState('api_toggle_magic_eden');
      const openaiState = await this.dbService.getSystemState('api_toggle_openai');
      const autoPostState = await this.dbService.getSystemState('api_toggle_auto_post');
      const aiAutoPostState = await this.dbService.getSystemState('api_toggle_ai_auto_post');

      // Parse and apply states, keeping defaults if not found
      if (twitterState) {
        this.state.twitterEnabled = twitterState === 'true';
      }
      if (moralisState) {
        this.state.moralisEnabled = moralisState === 'true';
      }
      if (magicEdenState) {
        this.state.magicEdenEnabled = magicEdenState === 'true';
      }
      if (openaiState) {
        this.state.openaiEnabled = openaiState === 'true';
      }
      if (autoPostState) {
        this.state.autoPostingEnabled = autoPostState === 'true';
      }
      if (aiAutoPostState) {
        this.state.aiAutoPostingEnabled = aiAutoPostState === 'true';
      }

      logger.info('Toggle states loaded from database:', this.state);
    } catch (error: any) {
      logger.warn('Failed to load toggle states from database, using defaults:', error.message);
    }
  }

  /**
   * Save current state to database
   */
  private async saveToDatabase(): Promise<void> {
    if (!this.dbService || !this.initialized) return;

    try {
      await this.dbService.setSystemState('api_toggle_twitter', this.state.twitterEnabled.toString());
      await this.dbService.setSystemState('api_toggle_moralis', this.state.moralisEnabled.toString());
      await this.dbService.setSystemState('api_toggle_magic_eden', this.state.magicEdenEnabled.toString());
      await this.dbService.setSystemState('api_toggle_openai', this.state.openaiEnabled.toString());
      await this.dbService.setSystemState('api_toggle_auto_post', this.state.autoPostingEnabled.toString());
      await this.dbService.setSystemState('api_toggle_ai_auto_post', this.state.aiAutoPostingEnabled.toString());
      
      logger.debug('Toggle states saved to database');
    } catch (error: any) {
      logger.error('Failed to save toggle states to database:', error.message);
    }
  }

  /**
   * Check if Twitter API is enabled
   */
  isTwitterEnabled(): boolean {
    return this.state.twitterEnabled;
  }

  /**
   * Check if Moralis API is enabled
   */
  isMoralisEnabled(): boolean {
    return this.state.moralisEnabled;
  }

  /**
   * Check if Magic Eden API is enabled
   */
  isMagicEdenEnabled(): boolean {
    return this.state.magicEdenEnabled;
  }

  /**
   * Check if OpenAI API is enabled
   */
  isOpenAIEnabled(): boolean {
    return this.state.openaiEnabled;
  }

  /**
   * Check if auto-posting is enabled
   */
  isAutoPostingEnabled(): boolean {
    return this.state.autoPostingEnabled;
  }

  /**
   * Check if AI auto-posting is enabled
   */
  isAIAutoPostingEnabled(): boolean {
    return this.state.aiAutoPostingEnabled;
  }

  /**
   * Get all toggle states
   */
  getState(): APIToggleState {
    return { ...this.state };
  }

  /**
   * Set Twitter API toggle state
   */
  async setTwitterEnabled(enabled: boolean): Promise<void> {
    this.state.twitterEnabled = enabled;
    
    // If Twitter is disabled, also disable auto-posting
    if (!enabled && this.state.autoPostingEnabled) {
      this.state.autoPostingEnabled = false;
    }
    
    await this.saveToDatabase();
  }

  /**
   * Set Moralis API toggle state
   */
  async setMoralisEnabled(enabled: boolean): Promise<void> {
    this.state.moralisEnabled = enabled;
    await this.saveToDatabase();
  }

  /**
   * Set Magic Eden API toggle state
   */
  async setMagicEdenEnabled(enabled: boolean): Promise<void> {
    this.state.magicEdenEnabled = enabled;
    await this.saveToDatabase();
  }

  /**
   * Set OpenAI API toggle state
   */
  async setOpenAIEnabled(enabled: boolean): Promise<void> {
    this.state.openaiEnabled = enabled;
    await this.saveToDatabase();
  }

  /**
   * Set auto-posting toggle state
   */
  async setAutoPostingEnabled(enabled: boolean): Promise<void> {
    // Can only enable if Twitter API is enabled
    if (enabled && !this.state.twitterEnabled) {
      throw new Error('Cannot enable auto-posting when Twitter API is disabled');
    }
    this.state.autoPostingEnabled = enabled;
    await this.saveToDatabase();
  }

  /**
   * Set AI auto-posting toggle state
   */
  async setAIAutoPostingEnabled(enabled: boolean): Promise<void> {
    // Can only enable if both Twitter API and OpenAI API are enabled
    if (enabled && !this.state.twitterEnabled) {
      throw new Error('Cannot enable AI auto-posting when Twitter API is disabled');
    }
    if (enabled && !this.state.openaiEnabled) {
      throw new Error('Cannot enable AI auto-posting when OpenAI API is disabled');
    }
    this.state.aiAutoPostingEnabled = enabled;
    
    // If disabling AI auto-posting, no cascading effects needed
    await this.saveToDatabase();
  }
}
