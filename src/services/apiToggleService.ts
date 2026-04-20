/**
 * API Toggle Service - Manages master API toggle states
 * Services check this before making external API calls
 */
import { IDatabaseService } from '../types';
import { logger } from '../utils/logger';

export interface APIToggleState {
  twitterEnabled: boolean;
  openaiEnabled: boolean;
  autoPostingEnabled: boolean;
  aiAutoPostingEnabled: boolean;
}

export class APIToggleService {
  private static instance: APIToggleService;
  private state: APIToggleState = {
    twitterEnabled: true,
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

  async initialize(dbService: IDatabaseService): Promise<void> {
    this.dbService = dbService;
    await this.loadFromDatabase();
    this.initialized = true;
    logger.info('APIToggleService initialized with database persistence');
  }

  private async loadFromDatabase(): Promise<void> {
    if (!this.dbService) return;

    try {
      const twitterState = await this.dbService.getSystemState('api_toggle_twitter');
      const openaiState = await this.dbService.getSystemState('api_toggle_openai');
      const autoPostState = await this.dbService.getSystemState('api_toggle_auto_post');
      const aiAutoPostState = await this.dbService.getSystemState('api_toggle_ai_auto_post');

      if (twitterState) {
        this.state.twitterEnabled = twitterState === 'true';
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

  private async saveToDatabase(): Promise<void> {
    if (!this.dbService || !this.initialized) return;

    try {
      await this.dbService.setSystemState('api_toggle_twitter', this.state.twitterEnabled.toString());
      await this.dbService.setSystemState('api_toggle_openai', this.state.openaiEnabled.toString());
      await this.dbService.setSystemState('api_toggle_auto_post', this.state.autoPostingEnabled.toString());
      await this.dbService.setSystemState('api_toggle_ai_auto_post', this.state.aiAutoPostingEnabled.toString());
      
      logger.debug('Toggle states saved to database');
    } catch (error: any) {
      logger.error('Failed to save toggle states to database:', error.message);
    }
  }

  isTwitterEnabled(): boolean {
    return this.state.twitterEnabled;
  }

  isOpenAIEnabled(): boolean {
    return this.state.openaiEnabled;
  }

  isAutoPostingEnabled(): boolean {
    return this.state.autoPostingEnabled;
  }

  isAIAutoPostingEnabled(): boolean {
    return this.state.aiAutoPostingEnabled;
  }

  getState(): APIToggleState {
    return { ...this.state };
  }

  async setTwitterEnabled(enabled: boolean): Promise<void> {
    this.state.twitterEnabled = enabled;
    
    if (!enabled && this.state.autoPostingEnabled) {
      this.state.autoPostingEnabled = false;
    }
    
    await this.saveToDatabase();
  }

  async setOpenAIEnabled(enabled: boolean): Promise<void> {
    this.state.openaiEnabled = enabled;
    await this.saveToDatabase();
  }

  async setAutoPostingEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.state.twitterEnabled) {
      throw new Error('Cannot enable auto-posting when Twitter API is disabled');
    }
    this.state.autoPostingEnabled = enabled;
    await this.saveToDatabase();
  }

  async setAIAutoPostingEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.state.twitterEnabled) {
      throw new Error('Cannot enable AI auto-posting when Twitter API is disabled');
    }
    if (enabled && !this.state.openaiEnabled) {
      throw new Error('Cannot enable AI auto-posting when OpenAI API is disabled');
    }
    this.state.aiAutoPostingEnabled = enabled;
    await this.saveToDatabase();
  }
}
