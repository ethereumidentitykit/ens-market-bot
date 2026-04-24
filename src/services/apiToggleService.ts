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
  /**
   * Gates the Friday-cadence weekly summary scheduler. Defaults to false —
   * the scheduler will silently skip its 19:00 + 20:00 Madrid runs until an
   * admin flips this on from the dashboard. Manual "Generate now" / "Post"
   * actions from the dashboard are NOT gated by this — they always work
   * regardless of the toggle (that's the whole point of manual override).
   */
  weeklySummaryAutoEnabled: boolean;
}

export class APIToggleService {
  private static instance: APIToggleService;
  private state: APIToggleState = {
    twitterEnabled: true,
    openaiEnabled: true,
    autoPostingEnabled: false,
    aiAutoPostingEnabled: false,
    weeklySummaryAutoEnabled: false
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
      const weeklySummaryAutoState = await this.dbService.getSystemState('api_toggle_weekly_summary_auto');

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
      if (weeklySummaryAutoState) {
        this.state.weeklySummaryAutoEnabled = weeklySummaryAutoState === 'true';
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
      await this.dbService.setSystemState('api_toggle_weekly_summary_auto', this.state.weeklySummaryAutoEnabled.toString());
      
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

  isWeeklySummaryAutoEnabled(): boolean {
    return this.state.weeklySummaryAutoEnabled;
  }

  getState(): APIToggleState {
    return { ...this.state };
  }

  async setTwitterEnabled(enabled: boolean): Promise<void> {
    this.state.twitterEnabled = enabled;
    
    if (!enabled && this.state.autoPostingEnabled) {
      this.state.autoPostingEnabled = false;
    }
    // Cascade: killing Twitter must also kill weekly-summary auto, since the
    // post leg of the weekly job needs Twitter. Same UX contract as the
    // autoPostingEnabled cascade above.
    if (!enabled && this.state.weeklySummaryAutoEnabled) {
      this.state.weeklySummaryAutoEnabled = false;
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

  /**
   * Enable / disable the weekly-summary auto scheduler. Same dependency
   * contract as `setAIAutoPostingEnabled`: turning ON requires both Twitter
   * and OpenAI to be enabled first. Manual dashboard actions are NOT gated
   * by this; only the cron-driven 19:00 + 20:00 Madrid runs are.
   */
  async setWeeklySummaryAutoEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.state.twitterEnabled) {
      throw new Error('Cannot enable weekly summary auto-posting when Twitter API is disabled');
    }
    if (enabled && !this.state.openaiEnabled) {
      throw new Error('Cannot enable weekly summary auto-posting when OpenAI API is disabled');
    }
    this.state.weeklySummaryAutoEnabled = enabled;
    await this.saveToDatabase();
  }
}
