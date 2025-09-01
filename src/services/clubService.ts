import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

export interface ClubInfo {
  name: string;
  handle: string;
}

export interface PatternClub {
  name: string;
  handle: string;
  pattern: string;
}

export interface FileBasedClub {
  name: string;
  handle: string;
  filename: string;
}

export interface ClubConfig {
  patternClubs: PatternClub[];
  fileBasedClubs: FileBasedClub[];
}

/**
 * ClubService - Manages ENS club detection and information
 * Supports both pattern-based clubs (regex) and file-based clubs (HashSet lookup)
 */
export class ClubService {
  // Pattern-based clubs (loaded from config)
  private patternClubs: PatternClub[] = [];
  private compiledPatterns: Map<string, RegExp> = new Map();

  // File-based clubs (loaded from config)  
  private clubDataSets: Map<string, Set<string>> = new Map();
  private clubMetadata: Map<string, ClubInfo> = new Map();
  private initialized = false;

  constructor() {
    this.initializeClubData();
  }

  /**
   * Initialize club data from JSON configuration and load files
   */
  private async initializeClubData(): Promise<void> {
    try {
      const configPath = path.join(process.cwd(), 'assets', 'clubs', 'config.json');
      
      // Check if config file exists
      if (!fs.existsSync(configPath)) {
        logger.warn('No club config file found, ClubService will have no clubs loaded');
        this.initialized = true;
        return;
      }

      // Load configuration
      const configData = fs.readFileSync(configPath, 'utf8');
      const config: ClubConfig = JSON.parse(configData);

      // Load pattern-based clubs and compile their regexes
      for (const club of config.patternClubs || []) {
        try {
          const regex = new RegExp(club.pattern, 'u'); // Include unicode flag for emoji support
          this.compiledPatterns.set(club.name, regex);
          this.patternClubs.push(club);
          logger.debug(`Compiled pattern for ${club.name}: ${club.pattern}`);
        } catch (patternError: any) {
          logger.error(`Failed to compile pattern for ${club.name}:`, patternError.message);
        }
      }

      // Load each file-based club
      for (const club of config.fileBasedClubs || []) {
        await this.loadClubFile(club);
      }

      this.initialized = true;
      logger.info(`ClubService initialized with ${this.patternClubs.length} pattern clubs and ${this.clubDataSets.size} file-based clubs`);
    } catch (error: any) {
      logger.error('Failed to initialize ClubService:', error.message);
      this.initialized = true; // Continue with no clubs
    }
  }

  /**
   * Load a single club file into memory
   */
  private async loadClubFile(club: FileBasedClub): Promise<void> {
    try {
      const filePath = path.join(process.cwd(), club.filename);
      
      if (!fs.existsSync(filePath)) {
        logger.warn(`Club file not found: ${filePath}`);
        return;
      }

      // Read file and create HashSet
      const fileContent = fs.readFileSync(filePath, 'utf8');
      const ensNames = new Set<string>();

      // Parse file (handle both .txt and .csv formats)
      const lines = fileContent.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) { // Skip empty lines and comments
          // Handle CSV files (take first column) or plain text files
          const ensName = trimmed.includes(',') ? trimmed.split(',')[0].trim() : trimmed;
          
          // Ensure .eth suffix
          const normalizedName = ensName.endsWith('.eth') ? ensName : `${ensName}.eth`;
          ensNames.add(normalizedName);
        }
      }

      // Store in maps
      const clubKey = `${club.name.toLowerCase().replace(/\s+/g, '_')}`;
      this.clubDataSets.set(clubKey, ensNames);
      this.clubMetadata.set(clubKey, {
        name: club.name,
        handle: club.handle
      });

      logger.info(`Loaded ${ensNames.size} names for ${club.name} from ${filePath}`);
    } catch (error: any) {
      logger.error(`Failed to load club file for ${club.name}:`, error.message);
    }
  }

  /**
   * Get all club information for an ENS name
   * Returns array to support multiple club memberships
   */
  public getClubInfo(ensName: string): ClubInfo[] {
    if (!ensName) return [];

    const clubs: ClubInfo[] = [];

    // Check pattern-based clubs from config
    for (const club of this.patternClubs) {
      const regex = this.compiledPatterns.get(club.name);
      if (regex && regex.test(ensName)) {
        clubs.push({ name: club.name, handle: club.handle });
      }
    }

    // Check file-based clubs
    for (const [clubKey, nameSet] of this.clubDataSets) {
      if (nameSet.has(ensName)) {
        const clubInfo = this.clubMetadata.get(clubKey);
        if (clubInfo) {
          clubs.push(clubInfo);
        }
      }
    }

    return clubs;
  }

  /**
   * Get comma-separated club handles for an ENS name
   * Compatible with existing newTweetFormatter methods
   */
  public getClubMention(ensName: string): string | null {
    const clubs = this.getClubInfo(ensName);
    if (clubs.length === 0) return null;
    
    return clubs.map(club => club.handle).join(', ');
  }

  /**
   * Get comma-separated club names for an ENS name  
   * Compatible with existing newTweetFormatter methods
   */
  public getClubName(ensName: string): string | null {
    const clubs = this.getClubInfo(ensName);
    if (clubs.length === 0) return null;
    
    return clubs.map(club => club.name).join(', ');
  }

  /**
   * Check if service is ready to use
   */
  public isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get statistics about loaded clubs
   */
  public getStats(): {
    patternClubs: number;
    fileBasedClubs: number;
    totalNamesLoaded: number;
  } {
    let totalNames = 0;
    for (const nameSet of this.clubDataSets.values()) {
      totalNames += nameSet.size;
    }

    return {
      patternClubs: this.patternClubs.length,
      fileBasedClubs: this.clubDataSets.size,
      totalNamesLoaded: totalNames
    };
  }
}
