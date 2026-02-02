import { logger } from '../utils/logger';
import { getClubLabel, getClubHandle, getFirstClubHandle } from '../constants/clubMetadata';

const GRAILS_API_BASE = 'https://grails-api.ethid.org/api/v1';

export interface GrailsNameResponse {
  success: boolean;
  data: {
    clubs: string[];
    has_numbers: boolean;
    has_emoji: boolean;
  };
}

/**
 * ClubService - Fetches ENS club data from the Grails API
 */
export class ClubService {
  /**
   * Fetch clubs for an ENS name from the Grails API
   */
  public async getClubs(ensName: string): Promise<string[]> {
    if (!ensName) return [];

    try {
      const url = `${GRAILS_API_BASE}/names/${encodeURIComponent(ensName)}`;
      const response = await fetch(url);

      if (!response.ok) {
        logger.warn(`[ClubService] API returned ${response.status} for ${ensName}`);
        // Fallback: detect by pattern when API fails
        return this.detectClubsByPattern(ensName);
      }

      const data: GrailsNameResponse = await response.json();

      if (!data.success || !data.data?.clubs) {
        logger.warn(`[ClubService] API returned no clubs for ${ensName} (success: ${data.success}, clubs: ${JSON.stringify(data.data?.clubs)})`);
        // Fallback: detect 999 Club by pattern (3-digit numbers 000-999)
        return this.detectClubsByPattern(ensName);
      }

      logger.debug(`[ClubService] Found ${data.data.clubs.length} clubs for ${ensName}: ${data.data.clubs.join(', ')}`);
      return data.data.clubs;
    } catch (error: any) {
      logger.error(`[ClubService] Failed to fetch clubs for ${ensName}:`, error.message);
      // Fallback: detect 999 Club by pattern (3-digit numbers 000-999)
      return this.detectClubsByPattern(ensName);
    }
  }

  /**
   * Fallback: Detect clubs by pattern matching when API fails
   * Currently detects 999 Club (3-digit numbers 000-999) and 10k Club (4-digit numbers)
   */
  private detectClubsByPattern(ensName: string): string[] {
    if (!ensName) return [];
    
    // Remove .eth suffix if present
    const label = ensName.toLowerCase().endsWith('.eth') 
      ? ensName.slice(0, -4) 
      : ensName;
    
    const clubs: string[] = [];
    
    // 999 Club: exactly 3 digits (000-999)
    if (/^\d{3}$/.test(label)) {
      clubs.push('999');
      logger.info(`[ClubService] Pattern fallback: ${ensName} detected as 999 Club (3-digit number)`);
    }
    // 10k Club: exactly 4 digits (0000-9999)
    else if (/^\d{4}$/.test(label)) {
      clubs.push('10k');
      logger.info(`[ClubService] Pattern fallback: ${ensName} detected as 10k Club (4-digit number)`);
    }
    
    return clubs;
  }

  /**
   * Get the display label for a club slug
   */
  public getClubLabel(slug: string): string {
    return getClubLabel(slug);
  }

  /**
   * Get the Twitter handle for a club slug
   */
  public getClubHandle(slug: string): string | null {
    return getClubHandle(slug);
  }

  /**
   * Get comma-separated club handles for club slugs
   * Filters out clubs without handles and deduplicates
   */
  public getClubMention(clubs: string[]): string | null {
    if (!clubs || clubs.length === 0) return null;

    const uniqueHandles = [...new Set(
      clubs
        .map(slug => getClubHandle(slug))
        .filter((handle): handle is string => handle !== null && handle.trim() !== '')
    )];

    if (uniqueHandles.length === 0) return null;
    return uniqueHandles.join(', ');
  }

  /**
   * Get comma-separated club names for club slugs
   */
  public getClubName(clubs: string[]): string | null {
    if (!clubs || clubs.length === 0) return null;
    return clubs.map(slug => getClubLabel(slug)).join(', ');
  }

  /**
   * Get formatted club string with names and handles properly paired
   * Format: "999 Club @ens999club, Pokemon @PokemonENS"
   * Deduplicates handles - only shows each handle once (on first category)
   */
  public getFormattedClubString(clubs: string[]): string | null {
    if (!clubs || clubs.length === 0) return null;

    const usedHandles = new Set<string>();
    const clubStrings = clubs.map(slug => {
      const label = getClubLabel(slug);
      const handle = getClubHandle(slug);

      // Only include handle if it hasn't been used yet
      if (handle && handle.trim() !== '' && !usedHandles.has(handle)) {
        usedHandles.add(handle);
        return `${label} ${handle}`;
      }
      return label;
    });

    return clubStrings.join(', ');
  }

  /**
   * Get the first available Twitter handle from a list of clubs
   */
  public getFirstClubHandle(clubs: string[]): string | null {
    return getFirstClubHandle(clubs);
  }
}
