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
    logger.info('[ClubService] Constructor called - initializing club data...');
    this.initializeClubData();
  }

  /**
   * Initialize club data from JSON configuration and load files
   */
  private async initializeClubData(): Promise<void> {
    try {
      const configPath = path.join(process.cwd(), 'assets', 'clubs', 'config.json');
      logger.info(`[ClubService] Loading config from: ${configPath}`);
      
      // Check if config file exists
      if (!fs.existsSync(configPath)) {
        logger.warn('No club config file found, ClubService will have no clubs loaded');
        this.initialized = true;
        return;
      }

      // Load configuration
      const configData = fs.readFileSync(configPath, 'utf8');
      const config: ClubConfig = JSON.parse(configData);
      logger.info(`[ClubService] Config loaded: ${config.patternClubs?.length || 0} pattern clubs, ${config.fileBasedClubs?.length || 0} file-based clubs`);

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
      const sampleNames: string[] = [];
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) { // Skip empty lines and comments
          // Handle CSV files (take first column) or plain text files
          const ensName = trimmed.includes(',') ? trimmed.split(',')[0].trim() : trimmed;
          
          // Ensure .eth suffix and normalize to lowercase for case-insensitive matching
          const normalizedName = ensName.endsWith('.eth') ? ensName.toLowerCase() : `${ensName.toLowerCase()}.eth`;
          ensNames.add(normalizedName);
          
          // Collect first few names for debugging
          if (sampleNames.length < 5) {
            sampleNames.push(normalizedName);
          }
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
      logger.info(`[ClubService] Sample names from ${club.name}: [${sampleNames.join(', ')}]`);
      
      // Check if edward.eth is specifically in this club (normalized check)
      if (ensNames.has('edward.eth')) {
        logger.info(`[ClubService] ✅ edward.eth found in ${club.name}`);
      } else {
        logger.info(`[ClubService] edward.eth NOT found in ${club.name}`);
      }
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

    // Normalize search term to lowercase for case-insensitive matching
    const normalizedEnsName = ensName.toLowerCase();
    logger.info(`[ClubService] Checking clubs for ENS name: ${ensName} (normalized: ${normalizedEnsName})`);
    const clubs: ClubInfo[] = [];

    // Check pattern-based clubs from config (patterns should match original case for flexibility)
    for (const club of this.patternClubs) {
      const regex = this.compiledPatterns.get(club.name);
      if (regex && regex.test(ensName)) {
        logger.info(`[ClubService] Pattern match found: ${club.name} for ${ensName}`);
        clubs.push({ name: club.name, handle: club.handle });
      }
    }

    // Check file-based clubs using normalized name
    logger.info(`[ClubService] Checking ${this.clubDataSets.size} file-based clubs for ${normalizedEnsName}`);
    for (const [clubKey, nameSet] of this.clubDataSets) {
      logger.info(`[ClubService] Checking ${clubKey} club (${nameSet.size} names) for ${normalizedEnsName}`);
      if (nameSet.has(normalizedEnsName)) {
        const clubInfo = this.clubMetadata.get(clubKey);
        if (clubInfo) {
          logger.info(`[ClubService] File-based match found: ${clubInfo.name} for ${ensName}`);
          clubs.push(clubInfo);
        }
      } else {
        logger.info(`[ClubService] No match in ${clubKey} for ${normalizedEnsName}`);
      }
    }

    logger.info(`[ClubService] Total clubs found for ${ensName}: ${clubs.length}`);
    return clubs;
  }

  /**
   * Get comma-separated club handles for an ENS name
   * Compatible with existing newTweetFormatter methods
   * Filters out clubs with empty handles
   */
  public getClubMention(ensName: string): string | null {
    const clubs = this.getClubInfo(ensName);
    if (clubs.length === 0) return null;
    
    // Filter out clubs with empty handles
    const clubsWithHandles = clubs.filter(club => club.handle && club.handle.trim() !== '');
    if (clubsWithHandles.length === 0) return null;
    
    return clubsWithHandles.map(club => club.handle).join(', ');
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
   * Get formatted club string with names and handles properly paired
   * Format: "999 Club @ENS999club, Pokemon Club @PokemonENS"
   */
  public getFormattedClubString(ensName: string): string | null {
    const clubs = this.getClubInfo(ensName);
    logger.info(`[ClubService] getFormattedClubString for ${ensName}: found ${clubs.length} clubs`);
    
    if (clubs.length === 0) {
      logger.info(`[ClubService] No clubs found for ${ensName}, returning null`);
      return null;
    }
    
    const clubStrings = clubs.map(club => {
      if (club.handle && club.handle.trim() !== '') {
        const formatted = `${club.name} ${club.handle}`;
        logger.info(`[ClubService] Formatted club with handle: ${formatted}`);
        return formatted;
      } else {
        logger.info(`[ClubService] Formatted club without handle: ${club.name}`);
        return club.name;
      }
    });
    
    const result = clubStrings.join(', ');
    logger.info(`[ClubService] Final formatted club string for ${ensName}: "${result}"`);
    return result;
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
