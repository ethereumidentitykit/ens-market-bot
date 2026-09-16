import axios from 'axios';
import { ENSTokenUtils } from './ensTokenUtils';
import { logger } from '../utils/logger';

/**
 * Fetches pre-rendered ENS NFT artwork from the EthID metadata service.
 *
 * EthID renders the .eth NFT card (gradient background, ENS logo, name with
 * emojis) server-side, so we no longer need to download the raw ENS SVG and
 * rebuild it ourselves. We always request the PNG variant: it can be dropped
 * straight into the tweet-image HTML, and unknown tokens return a 404 (the SVG
 * endpoint returns a generic placeholder with a 200, which would defeat the
 * fallback chain below).
 *
 * Lookup order:
 *   1. NameWrapper contract keyed by namehash("name.eth")
 *   2. BaseRegistrar contract keyed by labelhash("name")
 */
export class EthIdImageService {
  static readonly BASE_URL = 'https://metadata.ethid.org/mainnet';
  private static readonly TIMEOUT_MS = 10000;

  /**
   * Resolve an ENS name to its NFT image as a `data:image/png;base64,...` URL.
   * Returns null when neither EthID endpoint can serve the image, so callers
   * can substitute their own placeholder.
   */
  static async fetchNftImage(ensName: string): Promise<string | null> {
    const fullName = this.toFullName(ensName);
    if (!fullName) {
      logger.warn(`EthID image skipped: no usable ENS name (${JSON.stringify(ensName)})`);
      return null;
    }

    let candidates: Array<{ contract: string; tokenId: string; label: string }>;
    try {
      candidates = [
        { contract: ENSTokenUtils.NAME_WRAPPER_CONTRACT, tokenId: ENSTokenUtils.ensNameToNamehash(fullName), label: 'NameWrapper/namehash' },
        { contract: ENSTokenUtils.ENS_REGISTRY_CONTRACT, tokenId: ENSTokenUtils.ensNameToLabelhash(fullName), label: 'BaseRegistrar/labelhash' }
      ];
    } catch (error: any) {
      // viem's normalize() rejects names that are not valid ENS names (spaces, disallowed characters, ...)
      logger.warn(`EthID image skipped: "${fullName}" is not a normalizable ENS name (${error.message})`);
      return null;
    }

    for (const candidate of candidates) {
      const url = this.buildImageUrl(candidate.contract, candidate.tokenId);
      const image = await this.downloadPng(url);
      if (image) {
        logger.info(`🖼️ EthID NFT image loaded for ${fullName} via ${candidate.label}`);
        return image;
      }
      logger.debug(`EthID ${candidate.label} lookup failed for ${fullName}, trying next source`);
    }

    logger.warn(`EthID NFT image unavailable for ${fullName} from all sources`);
    return null;
  }

  /**
   * Build the EthID PNG image URL for a contract/token pair.
   */
  static buildImageUrl(contractAddress: string, tokenId: string): string {
    return `${this.BASE_URL}/${contractAddress}/${tokenId}/image/png`;
  }

  /**
   * Ensure the name carries a single trailing ".eth" (EthID keys wrapped names
   * by the namehash of the full name). Returns null for empty input.
   */
  private static toFullName(ensName: string): string | null {
    const trimmed = (ensName || '').trim();
    if (!trimmed) return null;
    return /\.eth$/i.test(trimmed) ? trimmed : `${trimmed}.eth`;
  }

  /**
   * Download one image URL and return it as a PNG data URL, or null on any failure.
   */
  private static async downloadPng(url: string): Promise<string | null> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: this.TIMEOUT_MS,
        headers: { 'User-Agent': 'ENS-TwitterBot/1.0', 'Accept': 'image/png' }
      });

      const contentType = String(response.headers['content-type'] || '');
      if (!contentType.includes('image/')) {
        logger.debug(`EthID returned non-image content (${contentType}) for ${url}`);
        return null;
      }

      const buffer = Buffer.from(response.data);
      if (buffer.length === 0) {
        logger.debug(`EthID returned an empty body for ${url}`);
        return null;
      }

      return `data:image/png;base64,${buffer.toString('base64')}`;
    } catch (error: any) {
      const status = error.response?.status;
      logger.debug(`EthID image request failed for ${url}: ${status ? `HTTP ${status}` : error.message}`);
      return null;
    }
  }
}
