import { logger } from '../utils/logger';
import { CLUB_LABELS, CLUB_TWITTER_HANDLES, getFirstClubHandle as getFirstClubHandleFallback } from '../constants/clubMetadata';

const GRAILS_API_BASE = 'https://grails-api.ethid.org/api/v1';
const CLUBS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface GrailsNameResponse {
  success: boolean;
  data: {
    clubs: string[];
    has_numbers: boolean;
    has_emoji: boolean;
  };
}

interface ClubMetadata {
  displayName: string;
}

/**
 * ClubService - Fetches ENS club data from the Grails API
 * Display names are fetched dynamically from /api/v1/clubs with a 5-min TTL cache.
 */
export class ClubService {
  private static clubsCache: Map<string, ClubMetadata> | null = null;
  private static clubsCacheTimestamp = 0;
  private static clubsCacheFetching = false;

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
        return this.detectClubsByPattern(ensName);
      }

      const data: GrailsNameResponse = await response.json();

      if (!data.success || !data.data?.clubs) {
        logger.warn(`[ClubService] API returned no clubs for ${ensName} (success: ${data.success}, clubs: ${JSON.stringify(data.data?.clubs)})`);
        return this.detectClubsByPattern(ensName);
      }

      logger.debug(`[ClubService] Found ${data.data.clubs.length} clubs for ${ensName}: ${data.data.clubs.join(', ')}`);
      return data.data.clubs;
    } catch (error: any) {
      logger.error(`[ClubService] Failed to fetch clubs for ${ensName}:`, error.message);
      return this.detectClubsByPattern(ensName);
    }
  }

  /**
   * Fallback: Detect clubs by pattern matching when API fails
   */
  private detectClubsByPattern(ensName: string): string[] {
    if (!ensName) return [];
    
    const label = ensName.toLowerCase().endsWith('.eth') 
      ? ensName.slice(0, -4) 
      : ensName;
    
    const clubs: string[] = [];
    
    if (/^\d{3}$/.test(label)) {
      clubs.push('999');
      logger.info(`[ClubService] Pattern fallback: ${ensName} detected as 999 Club`);
    } else if (/^\d{4}$/.test(label)) {
      clubs.push('10k');
      logger.info(`[ClubService] Pattern fallback: ${ensName} detected as 10k Club`);
    }
    
    return clubs;
  }

  /**
   * Refresh the clubs metadata cache from /api/v1/clubs if stale.
   * Uses a static cache shared across all ClubService instances.
   */
  private async ensureClubsCache(): Promise<void> {
    const now = Date.now();
    if (ClubService.clubsCache && (now - ClubService.clubsCacheTimestamp) < CLUBS_CACHE_TTL_MS) {
      return;
    }

    if (ClubService.clubsCacheFetching) return;
    ClubService.clubsCacheFetching = true;

    try {
      const response = await fetch(`${GRAILS_API_BASE}/clubs`, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        logger.warn(`[ClubService] Failed to refresh clubs cache: HTTP ${response.status}`);
        return;
      }

      const data = await response.json();
      if (!data.success || !data.data?.clubs) {
        logger.warn('[ClubService] Clubs endpoint returned unexpected format');
        return;
      }

      const newCache = new Map<string, ClubMetadata>();
      for (const club of data.data.clubs) {
        if (club.name && club.display_name) {
          newCache.set(club.name, { displayName: club.display_name });
        }
      }

      ClubService.clubsCache = newCache;
      ClubService.clubsCacheTimestamp = now;
      logger.debug(`[ClubService] Refreshed clubs cache: ${newCache.size} clubs loaded`);
    } catch (error: any) {
      logger.warn(`[ClubService] Failed to refresh clubs cache: ${error.message}`);
    } finally {
      ClubService.clubsCacheFetching = false;
    }
  }

  /**
   * Get the display label for a club slug.
   * Prefers the API-cached display_name, falls back to hardcoded CLUB_LABELS.
   */
  public async getClubLabel(slug: string): Promise<string> {
    await this.ensureClubsCache();
    const cached = ClubService.clubsCache?.get(slug);
    if (cached) return cached.displayName;
    return CLUB_LABELS[slug] || slug;
  }

  /**
   * Get the Twitter handle for a club slug (hardcoded — API doesn't provide these yet)
   */
  public getClubHandle(slug: string): string | null {
    return CLUB_TWITTER_HANDLES[slug] || null;
  }

  /**
   * Get comma-separated club handles for club slugs
   */
  public getClubMention(clubs: string[]): string | null {
    if (!clubs || clubs.length === 0) return null;

    const uniqueHandles = [...new Set(
      clubs
        .map(slug => this.getClubHandle(slug))
        .filter((handle): handle is string => handle !== null && handle.trim() !== '')
    )];

    if (uniqueHandles.length === 0) return null;
    return uniqueHandles.join(', ');
  }

  /**
   * Get comma-separated club names for club slugs
   */
  public async getClubName(clubs: string[]): Promise<string | null> {
    if (!clubs || clubs.length === 0) return null;
    const labels = await Promise.all(clubs.map(slug => this.getClubLabel(slug)));
    return labels.join(', ');
  }

  /**
   * Get formatted club string with names and handles properly paired
   * Format: "999 Club @ens999club, Pokemon @PokemonENS"
   * Deduplicates handles - only shows each handle once (on first category)
   */
  public async getFormattedClubString(clubs: string[]): Promise<string | null> {
    if (!clubs || clubs.length === 0) return null;

    const usedHandles = new Set<string>();
    const clubStrings: string[] = [];

    for (const slug of clubs) {
      const label = await this.getClubLabel(slug);
      const handle = this.getClubHandle(slug);

      if (handle && handle.trim() !== '' && !usedHandles.has(handle)) {
        usedHandles.add(handle);
        clubStrings.push(`${label} ${handle}`);
      } else {
        clubStrings.push(label);
      }
    }

    return clubStrings.join(', ');
  }

  /**
   * Get the first available Twitter handle from a list of clubs
   */
  public getFirstClubHandle(clubs: string[]): string | null {
    return getFirstClubHandleFallback(clubs);
  }
}
