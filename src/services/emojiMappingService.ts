import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

interface EmojiMapping {
    filePath: string;
    detectedName: string;
    unicodeSequence: string;
    codepointsHex: string;
    status: 'mapped' | 'unmapped';
    method: string;
}

export class EmojiMappingService {
    private mappings: Map<string, EmojiMapping> = new Map();
    private initialized = false;
    private emojiAssetsPath: string;
    private emojiPattern!: RegExp;

    constructor() {
        // Path to emoji assets relative to project root
        this.emojiAssetsPath = path.join(process.cwd(), 'assets', 'emojis', 'all');
    }

    /**
     * Initialize the emoji mapping service by loading the CSV data
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        try {
            const csvPath = path.join(process.cwd(), 'assets', 'emoji_mapping.csv');
            const csvContent = fs.readFileSync(csvPath, 'utf-8');
            
            const lines = csvContent.split('\n').slice(1); // Skip header
            let mappedCount = 0;

            for (const line of lines) {
                if (!line.trim()) continue;

                const [filePath, detectedName, unicodeSequence, codepointsHex, status, method] = line.split(',');
                
                if (status === 'mapped' && unicodeSequence) {
                    const mapping: EmojiMapping = {
                        filePath,
                        detectedName,
                        unicodeSequence,
                        codepointsHex,
                        status: status as 'mapped',
                        method
                    };

                    // Use Unicode sequence as the key for lookup
                    this.mappings.set(unicodeSequence, mapping);
                    mappedCount++;
                }
            }

            this.emojiPattern = this.buildEmojiPattern();
            this.initialized = true;
            logger.info(`EmojiMappingService initialized with ${mappedCount} mapped emojis`);

        } catch (error) {
            logger.error('Failed to initialize EmojiMappingService:', error);
            throw error;
        }
    }

    /**
     * Normalize Unicode sequence by removing variation selectors (FE0F)
     * This allows matching emojis with or without emoji-style selectors
     */
    private normalizeUnicodeSequence(sequence: string): string {
        // Remove variation selector-16 (FE0F) which specifies emoji presentation
        return sequence.replace(/\uFE0F/g, '');
    }

    /**
     * Get the SVG content for a given Unicode emoji sequence
     */
    async getEmojiSvg(unicodeSequence: string): Promise<string | null> {
        if (!this.initialized) {
            await this.initialize();
        }

        // Try exact match first
        let mapping = this.mappings.get(unicodeSequence);
        
        // If no exact match, try normalized sequence (without variation selectors)
        if (!mapping) {
            const normalizedSequence = this.normalizeUnicodeSequence(unicodeSequence);
            mapping = this.mappings.get(normalizedSequence);
        }
        
        // If still no match, try finding a mapping that normalizes to our input
        if (!mapping) {
            const normalizedInput = this.normalizeUnicodeSequence(unicodeSequence);
            for (const [key, value] of this.mappings.entries()) {
                if (this.normalizeUnicodeSequence(key) === normalizedInput) {
                    mapping = value;
                    break;
                }
            }
        }
        
        if (!mapping) {
            return null;
        }

        try {
            // Extract filename from the file path (remove 'all/' prefix)
            const filename = path.basename(mapping.filePath);
            const svgPath = path.join(this.emojiAssetsPath, filename);
            
            if (!fs.existsSync(svgPath)) {
                logger.warn(`Emoji SVG file not found: ${svgPath}`);
                return null;
            }

            return fs.readFileSync(svgPath, 'utf-8');
        } catch (error) {
            logger.error(`Error reading emoji SVG for ${unicodeSequence}:`, error);
            return null;
        }
    }

    /**
     * Replace emoji Unicode characters in text with SVG elements
     * This method finds emojis in text and replaces them with inline SVG
     */
    async replaceEmojisWithSvg(text: string): Promise<string> {
        if (!this.initialized) {
            await this.initialize();
        }

        let result = '';
        let cursor = 0;
        for (const match of text.matchAll(this.emojiPattern)) {
            const svgContent = await this.getEmojiSvg(match[0]);
            if (!svgContent) continue;

            result += text.slice(cursor, match.index) + this.createInlineSvg(svgContent);
            cursor = match.index + match[0].length;
        }
        return result + text.slice(cursor);
    }

    /**
     * Create an inline SVG element suitable for HTML integration
     */
    private createInlineSvg(svgContent: string): string {
        // Add CSS classes and styling for proper text integration
        const styledSvg = svgContent
            .replace('<svg', '<svg class="emoji-inline" style="display: inline-block; vertical-align: middle; width: 1.2em; height: 1.2em;"')
            .replace(/xmlns:xlink="[^"]*"/g, '') // Remove xlink namespace if present
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();

        return styledSvg;
    }

    /**
     * Matches any mapped sequence, with or without its variation selectors. Longest
     * alternatives come first, so each match is the longest emoji at the leftmost
     * position: ZWJ sequences stay whole and adjacent flags stay paired
     * (🇨🇦🇩🇪 holds 🇦🇩 across its boundary).
     */
    private buildEmojiPattern(): RegExp {
        const sequences = new Set<string>();
        for (const sequence of this.mappings.keys()) {
            sequences.add(sequence);
            sequences.add(this.normalizeUnicodeSequence(sequence));
        }

        const alternatives = Array.from(sequences)
            .sort((a, b) => b.length - a.length)
            .map((sequence) => this.escapeRegExp(sequence));
        return new RegExp(alternatives.join('|'), 'gu');
    }

    /**
     * Escape special regex characters
     */
    private escapeRegExp(string: string): string {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Get statistics about the emoji mapping
     */
    getStats(): { totalMapped: number; initialized: boolean } {
        return {
            totalMapped: this.mappings.size,
            initialized: this.initialized
        };
    }

    /**
     * Check if a specific emoji is supported
     */
    isEmojiSupported(unicodeSequence: string): boolean {
        // Try exact match first
        if (this.mappings.has(unicodeSequence)) {
            return true;
        }
        
        // Try normalized sequence (without variation selectors)
        const normalizedSequence = this.normalizeUnicodeSequence(unicodeSequence);
        if (this.mappings.has(normalizedSequence)) {
            return true;
        }
        
        // Try finding a mapping that normalizes to our input
        const normalizedInput = this.normalizeUnicodeSequence(unicodeSequence);
        for (const key of this.mappings.keys()) {
            if (this.normalizeUnicodeSequence(key) === normalizedInput) {
                return true;
            }
        }
        
        return false;
    }
}

// Export singleton instance
export const emojiMappingService = new EmojiMappingService();
