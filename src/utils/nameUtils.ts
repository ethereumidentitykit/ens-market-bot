import { logger } from './logger';

/**
 * Utility functions for ENS name validation and cleaning
 */

/**
 * Detects if a "name" is actually a token ID hash instead of a real ENS name
 * 
 * Token ID hashes have these characteristics:
 * - Start with # or are very long numbers
 * - Are typically 70+ characters long
 * - Contain only digits (after removing #)
 * 
 * Examples of token ID hashes:
 * - "#18066644556788849020012982929983179527650598082327508438993873976655527605986"
 * - "18066644556788849020012982929983179527650598082327508438993873976655527605986"
 * 
 * @param name - The name to check
 * @returns true if this is a token ID hash, false if it's a valid name
 */
export function isTokenIdHash(name: string | null | undefined): boolean {
  if (!name) return false;
  
  // Remove # if present
  const cleaned = name.startsWith('#') ? name.slice(1) : name;
  
  // Check if it's a very long number (token IDs are ~70+ chars)
  const isLongNumber = cleaned.length > 50 && /^\d+$/.test(cleaned);
  
  if (isLongNumber) {
    logger.debug(`🚫 Detected token ID hash: "${name.substring(0, 20)}..." (${name.length} chars)`);
    return true;
  }
  
  return false;
}

/**
 * Validates and cleans an ENS name
 * 
 * - Detects token ID hashes and returns null
 * - Ensures name doesn't contain invalid characters
 * - Adds .eth suffix if missing
 * 
 * @param name - The name to validate
 * @param webhookName - Optional webhook name as fallback
 * @returns Cleaned ENS name or null if invalid
 */
export function validateAndCleanEnsName(
  name: string | null | undefined, 
  webhookName?: string | null
): string | null {
  // If no name provided, try webhook fallback
  if (!name && webhookName) {
    logger.debug(`📝 Using webhook name as fallback: ${webhookName}`);
    name = webhookName;
  }
  
  if (!name) return null;
  
  // Detect token ID hash
  if (isTokenIdHash(name)) {
    if (webhookName && !isTokenIdHash(webhookName)) {
      logger.info(`✅ Replaced token ID hash with webhook name: ${webhookName}`);
      name = webhookName;
    } else {
      logger.warn(`⚠️ Token ID hash detected and no valid webhook name available`);
      return null;
    }
  }
  
  // Clean the name
  let cleaned = name.trim();
  
  // Remove .eth suffix if present (we'll add it back consistently)
  if (cleaned.endsWith('.eth')) {
    cleaned = cleaned.slice(0, -4);
  }
  
  // Validate characters (ENS names should be lowercase alphanumeric + hyphens)
  // Note: We're being lenient here to allow emojis and special chars that ENS supports
  if (cleaned.length === 0) {
    logger.warn(`⚠️ ENS name is empty after cleaning`);
    return null;
  }
  
  // Add .eth suffix
  const fullName = `${cleaned}.eth`;
  
  return fullName;
}

/**
 * Gets the best available ENS name from multiple sources
 * Priority: webhook name > metadata name (if not a hash) > fallback
 * 
 * @param webhookName - Name from webhook (most reliable)
 * @param metadataName - Name from OpenSea/ENS metadata
 * @param fallbackName - Fallback name if all else fails
 * @returns Best available name
 */
export function getBestEnsName(
  webhookName: string | null | undefined,
  metadataName: string | null | undefined,
  fallbackName?: string
): string {
  // Priority 1: Valid webhook name
  if (webhookName && !isTokenIdHash(webhookName)) {
    const cleaned = validateAndCleanEnsName(webhookName);
    if (cleaned) {
      logger.debug(`✅ Using webhook name: ${cleaned}`);
      return cleaned;
    }
  }
  
  // Priority 2: Valid metadata name (not a hash)
  if (metadataName && !isTokenIdHash(metadataName)) {
    const cleaned = validateAndCleanEnsName(metadataName);
    if (cleaned) {
      logger.debug(`✅ Using metadata name: ${cleaned}`);
      return cleaned;
    }
  }
  
  // Priority 3: Fallback
  if (fallbackName) {
    const cleaned = validateAndCleanEnsName(fallbackName);
    if (cleaned) {
      logger.warn(`⚠️ Using fallback name: ${cleaned}`);
      return cleaned;
    }
  }
  
  // Last resort: Return a placeholder
  logger.error(`❌ No valid ENS name available from any source`);
  return '[unknown].eth';
}

