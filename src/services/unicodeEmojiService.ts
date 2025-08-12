import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

export interface UnicodeEmojiInfo {
  emoji: string;
  position: number;
  codePoints: string;
  description: string;
  status: 'fully-qualified' | 'minimally-qualified' | 'unqualified';
}

/**
 * Unicode-based emoji service that uses official Unicode emoji data
 * instead of SVG files. This ensures proper ZWJ sequence handling.
 */
export class UnicodeEmojiService {
  private static emojiData: Map<string, { description: string; status: string }> = new Map();
  private static initialized = false;

  /**
   * Initialize the service by loading Unicode emoji data
   */
  private static initialize(): void {
    if (this.initialized) return;

    try {
      // Load emoji-test.txt which contains all standard emojis
      const emojiTestPath = path.join(process.cwd(), 'assets', 'emoji-lists', 'emoji-test.txt');
      const emojiTestData = fs.readFileSync(emojiTestPath, 'utf-8');
      
      // Parse the emoji test file
      const lines = emojiTestData.split('\n');
      let emojiCount = 0;
      
      for (const line of lines) {
        // Skip comments and empty lines
        if (line.startsWith('#') || line.trim() === '') continue;
        
        // Parse format: code_point(s); status # emoji description
        const match = line.match(/^([A-F0-9 ]+)\s*;\s*(fully-qualified|minimally-qualified|unqualified)\s*#\s*(.+)$/);
        if (match) {
          const [, codePointsStr, status, rest] = match;
          
          // Extract the actual emoji from the comment (first character after #)
          const emojiMatch = rest.match(/^(\S+)/);
          if (emojiMatch) {
            const emoji = emojiMatch[1];
            const description = rest.substring(emojiMatch[0].length).trim();
            
            // Store the emoji data
            this.emojiData.set(emoji, { description, status });
            emojiCount++;
          }
        }
      }
      
      logger.info(`Loaded ${emojiCount} Unicode emojis from emoji-test.txt`);
      this.initialized = true;
      
    } catch (error) {
      logger.error('Failed to load Unicode emoji data:', error);
      // Fallback to empty data
      this.initialized = true;
    }
  }

  /**
   * Detect emojis in text using Unicode emoji data
   * Prioritizes longer sequences (ZWJ) over shorter ones
   */
  static detectEmojis(text: string): UnicodeEmojiInfo[] {
    this.initialize();
    
    const emojis: UnicodeEmojiInfo[] = [];
    const textLength = text.length;
    
    // Track positions that have been matched
    const matchedPositions = new Set<number>();
    
    // Get all known emojis sorted by length (longest first for ZWJ priority)
    const knownEmojis = Array.from(this.emojiData.keys()).sort((a, b) => b.length - a.length);
    
    for (const emoji of knownEmojis) {
      let position = 0;
      
      while ((position = text.indexOf(emoji, position)) !== -1) {
        const endPosition = position + emoji.length;
        
        // Check if this position range is already covered
        let isOverlapping = false;
        for (let i = position; i < endPosition; i++) {
          if (matchedPositions.has(i)) {
            isOverlapping = true;
            break;
          }
        }
        
        if (!isOverlapping) {
          // Mark positions as matched
          for (let i = position; i < endPosition; i++) {
            matchedPositions.add(i);
          }
          
          const emojiData = this.emojiData.get(emoji)!;
          const codePoints = emoji.split('').map(c => 
            c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
          ).join(' ');
          
          emojis.push({
            emoji,
            position,
            codePoints,
            description: emojiData.description,
            status: emojiData.status as any
          });
        }
        
        position += 1; // Move forward to find overlapping matches
      }
    }
    
    // Sort by position
    return emojis.sort((a, b) => a.position - b.position);
  }

  /**
   * Check if text contains any renderable emojis
   */
  static hasRenderableEmojis(text: string): boolean {
    return this.detectEmojis(text).length > 0;
  }

  /**
   * Get all supported emojis
   */
  static getSupportedEmojis(): string[] {
    this.initialize();
    return Array.from(this.emojiData.keys());
  }

  /**
   * Get emoji information
   */
  static getEmojiInfo(emoji: string): { description: string; status: string } | null {
    this.initialize();
    return this.emojiData.get(emoji) || null;
  }

  /**
   * Remove emojis from text (for fallback text rendering)
   */
  static removeEmojis(text: string): string {
    this.initialize();
    
    let cleanText = text;
    
    // Remove all known emojis (longest first to handle ZWJ sequences)
    const knownEmojis = Array.from(this.emojiData.keys()).sort((a, b) => b.length - a.length);
    for (const emoji of knownEmojis) {
      cleanText = cleanText.replace(new RegExp(emoji.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '');
    }
    
    return cleanText.trim();
  }

  /**
   * Get statistics about loaded emoji data
   */
  static getStats(): { 
    totalEmojis: number; 
    fullyQualified: number; 
    minimallyQualified: number; 
    unqualified: number; 
  } {
    this.initialize();
    
    let fullyQualified = 0;
    let minimallyQualified = 0;
    let unqualified = 0;
    
    for (const data of this.emojiData.values()) {
      switch (data.status) {
        case 'fully-qualified':
          fullyQualified++;
          break;
        case 'minimally-qualified':
          minimallyQualified++;
          break;
        case 'unqualified':
          unqualified++;
          break;
      }
    }
    
    return {
      totalEmojis: this.emojiData.size,
      fullyQualified,
      minimallyQualified,
      unqualified
    };
  }
}
