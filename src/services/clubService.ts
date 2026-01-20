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
        return [];
      }

      const data: GrailsNameResponse = await response.json();

      if (!data.success || !data.data?.clubs) {
        return [];
      }

      logger.debug(`[ClubService] Found ${data.data.clubs.length} clubs for ${ensName}: ${data.data.clubs.join(', ')}`);
      return data.data.clubs;
    } catch (error: any) {
      logger.error(`[ClubService] Failed to fetch clubs for ${ensName}:`, error.message);
      return [];
    }
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
   * Filters out clubs without handles
   */
  public getClubMention(clubs: string[]): string | null {
    if (!clubs || clubs.length === 0) return null;

    const handles = clubs
      .map(slug => getClubHandle(slug))
      .filter((handle): handle is string => handle !== null && handle.trim() !== '');

    if (handles.length === 0) return null;
    return handles.join(', ');
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
   */
  public getFormattedClubString(clubs: string[]): string | null {
    if (!clubs || clubs.length === 0) return null;

    const clubStrings = clubs.map(slug => {
      const label = getClubLabel(slug);
      const handle = getClubHandle(slug);

      if (handle && handle.trim() !== '') {
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
