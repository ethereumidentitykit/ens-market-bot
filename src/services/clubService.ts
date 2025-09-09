import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

export interface ClubInfo {
  id: string;
  name: string;
  handle: string;
  lineNumber?: number; // Optional line number for ranked clubs
}

export interface PatternClub {
  id: string;
  name: string;
  handle: string;
  pattern: string;
}

export interface FileBasedClub {
  id: string;
  name: string;
  handle: string;
  filename: string;
  includeLineNumber?: boolean; // Optional: include line number for ranked clubs
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
  private clubLineNumbers: Map<string, Map<string, number>> = new Map(); // Maps club -> (name -> lineNumber)
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
      const lineNumberMap = new Map<string, number>();
      
      for (let fileLineNumber = 1; fileLineNumber <= lines.length; fileLineNumber++) {
        const line = lines[fileLineNumber - 1]; // Convert to 0-based index
        const trimmed = line.trim();
        
        // Skip comment lines but process both data lines AND blank lines (missing entries)
        if (!trimmed.startsWith('#')) {
          
          // If line has data, store it
          if (trimmed) {
            // Handle CSV files (take first column) or plain text files
            const ensName = trimmed.includes(',') ? trimmed.split(',')[0].trim() : trimmed;
            
            // Ensure .eth suffix and normalize to lowercase for case-insensitive matching
            const normalizedName = ensName.endsWith('.eth') ? ensName.toLowerCase() : `${ensName.toLowerCase()}.eth`;
            ensNames.add(normalizedName);
            
            // Store TRUE file line number (includes missing entries as blank lines)
            if (club.includeLineNumber) {
              lineNumberMap.set(normalizedName, fileLineNumber);
            }
            
            // Collect first few names for debugging
            if (sampleNames.length < 5) {
              const formattedLineNumber = club.includeLineNumber ? fileLineNumber.toLocaleString('en-US') : null;
              const debugName = formattedLineNumber ? `${normalizedName}: #${formattedLineNumber}` : normalizedName;
              sampleNames.push(debugName);
            }
          }
          // Note: blank lines (missing entries) are acknowledged but not stored in the dataset
        }
      }

      // Store in maps
      const clubKey = `${club.name.toLowerCase().replace(/\s+/g, '_')}`;
      this.clubDataSets.set(clubKey, ensNames);
      this.clubMetadata.set(clubKey, {
        id: club.id,
        name: club.name,
        handle: club.handle
      });
      
      // Store line number mapping if enabled
      if (club.includeLineNumber && lineNumberMap.size > 0) {
        this.clubLineNumbers.set(clubKey, lineNumberMap);
        const totalLines = lines.length;
        const blankLines = totalLines - ensNames.size;
        logger.info(`[ClubService] Line number tracking enabled for ${club.name} (${lineNumberMap.size} entries, ${blankLines} missing/blank)`);
      }

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
    logger.debug(`[ClubService] Checking clubs for ENS name: ${ensName} (normalized: ${normalizedEnsName})`);
    const clubs: ClubInfo[] = [];

    // Check pattern-based clubs from config (patterns should match original case for flexibility)
    for (const club of this.patternClubs) {
      const regex = this.compiledPatterns.get(club.name);
      if (regex && regex.test(ensName)) {
        logger.debug(`[ClubService] Pattern match found: ${club.name} for ${ensName}`);
        clubs.push({ id: club.id, name: club.name, handle: club.handle });
      }
    }

    // Check file-based clubs using normalized name
    logger.debug(`[ClubService] Checking ${this.clubDataSets.size} file-based clubs for ${normalizedEnsName}`);
    for (const [clubKey, nameSet] of this.clubDataSets) {
      logger.debug(`[ClubService] Checking ${clubKey} club (${nameSet.size} names) for ${normalizedEnsName}`);
      if (nameSet.has(normalizedEnsName)) {
        const clubInfo = this.clubMetadata.get(clubKey);
        if (clubInfo) {
          // Check if this club has line number tracking
          const lineNumberMap = this.clubLineNumbers.get(clubKey);
          const lineNumber = lineNumberMap?.get(normalizedEnsName);
          
          const clubInfoWithLine: ClubInfo = {
            id: clubInfo.id,
            name: clubInfo.name,
            handle: clubInfo.handle,
            ...(lineNumber && { lineNumber })
          };
          
          const formattedLogLineNumber = lineNumber ? lineNumber.toLocaleString('en-US') : null;
          const logMessage = formattedLogLineNumber 
            ? `File-based match found: ${clubInfo.name}: #${formattedLogLineNumber} for ${ensName}`
            : `File-based match found: ${clubInfo.name} for ${ensName}`;
          logger.debug(`[ClubService] ${logMessage}`);
          
          clubs.push(clubInfoWithLine);
        }
      } else {
        logger.debug(`[ClubService] No match in ${clubKey} for ${normalizedEnsName}`);
      }
    }

    logger.debug(`[ClubService] Total clubs found for ${ensName}: ${clubs.length}`);
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
      // Build club name with optional line number (formatted with commas)
      const formattedLineNumber = club.lineNumber ? club.lineNumber.toLocaleString('en-US') : null;
      const clubNameWithNumber = formattedLineNumber ? `${club.name} #${formattedLineNumber}` : club.name;
      
      if (club.handle && club.handle.trim() !== '') {
        const formatted = `${clubNameWithNumber} ${club.handle}`;
        logger.info(`[ClubService] Formatted club with handle: ${formatted}`);
        return formatted;
      } else {
        logger.info(`[ClubService] Formatted club without handle: ${clubNameWithNumber}`);
        return clubNameWithNumber;
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
    clubsWithLineNumbers: number;
    totalNamesLoaded: number;
  } {
    let totalNames = 0;
    for (const nameSet of this.clubDataSets.values()) {
      totalNames += nameSet.size;
    }

    return {
      patternClubs: this.patternClubs.length,
      fileBasedClubs: this.clubDataSets.size,
      clubsWithLineNumbers: this.clubLineNumbers.size,
      totalNamesLoaded: totalNames
    };
  }
}
