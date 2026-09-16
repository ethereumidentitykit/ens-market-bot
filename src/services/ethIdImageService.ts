import axios from 'axios';
import { ENSTokenUtils } from './ensTokenUtils';
import { buildEthIdSvgCard } from './ethIdCardBuilder';
import { logger } from '../utils/logger';

/**
 * ENS NFT card markup ready to drop into a square container in the tweet-image HTML.
 */
export interface EthIdNftCard {
  /** 'svg': inline vector card with the bot's Apple emoji. 'png': EthID's own raster (Google emoji). */
  format: 'svg' | 'png';
  /** Inline <svg> or <img> that fills its parent (parent should set size + overflow:hidden). */
  html: string;
  /** Which lookup served it, for logs (e.g. "NameWrapper/namehash"). */
  source: string;
}

interface Candidate {
  contract: string;
  tokenId: string;
  label: string;
}

/**
 * Fetches ENS NFT artwork from the EthID metadata service.
 *
 * EthID renders the .eth card (gradient or avatar background, ENS logo, name)
 * server-side. Lookup order for a name:
 *   1. NameWrapper contract keyed by namehash("name.eth")
 *   2. BaseRegistrar contract keyed by labelhash("name")
 *
 * For each contract the SVG endpoint is tried first and rebuilt with the bot's
 * Apple emoji (see ethIdCardBuilder). EthID answers unknown tokens on the SVG
 * endpoint with a 404, or occasionally a 200 card whose label is a bracketed
 * hash like "[0x0000...0001].eth"; both are treated as "not found here" and
 * the next contract is tried. If the SVG is served but cannot be rebuilt (or
 * the request fails for another reason), the PNG endpoint is used for the
 * same contract.
 *
 * Set ETHID_NFT_IMAGE_FORMAT=png to skip the SVG path entirely and use EthID's
 * PNGs, which carry Google's emoji designs. This is the quickest way back to
 * the previous behaviour without a code change.
 */
export class EthIdImageService {
  static readonly BASE_URL = 'https://metadata.ethid.org/mainnet';
  private static readonly TIMEOUT_MS = 10000;
  private static cardCounter = 0;

  static get preferredFormat(): 'svg' | 'png' {
    return (process.env.ETHID_NFT_IMAGE_FORMAT || '').toLowerCase() === 'png' ? 'png' : 'svg';
  }

  /**
   * Resolve an ENS name to its NFT card markup, or null when EthID cannot
   * serve it so callers can substitute their own placeholder.
   */
  static async fetchNftCard(ensName: string): Promise<EthIdNftCard | null> {
    const fullName = this.toFullName(ensName);
    if (!fullName) {
      logger.warn(`EthID image skipped: no usable ENS name (${JSON.stringify(ensName)})`);
      return null;
    }

    let candidates: Candidate[];
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

    const preferSvg = this.preferredFormat === 'svg';

    for (const candidate of candidates) {
      if (preferSvg) {
        const svgCard = await this.fetchSvgCard(candidate, fullName);
        if (svgCard === 'unknown') {
          logger.debug(`EthID ${candidate.label} does not know ${fullName}, trying next source`);
          continue;
        }
        if (svgCard) {
          logger.info(`🖼️ EthID NFT card (svg) loaded for ${fullName} via ${candidate.label}`);
          return svgCard;
        }
        logger.debug(`EthID ${candidate.label} SVG failed for ${fullName}, trying PNG`);
      }

      const pngCard = await this.fetchPngCard(candidate);
      if (pngCard) {
        logger.info(`🖼️ EthID NFT card (png) loaded for ${fullName} via ${candidate.label}`);
        return pngCard;
      }
      logger.debug(`EthID ${candidate.label} PNG failed for ${fullName}, trying next source`);
    }

    logger.warn(`EthID NFT image unavailable for ${fullName} from all sources`);
    return null;
  }

  /**
   * Build the EthID image URL for a contract/token pair.
   */
  static buildImageUrl(contractAddress: string, tokenId: string, format: 'svg' | 'png' = 'svg'): string {
    const base = `${this.BASE_URL}/${contractAddress}/${tokenId}/image`;
    return format === 'png' ? `${base}/png` : base;
  }

  /**
   * SVG path: returns the rebuilt card, 'unknown' when EthID does not know the
   * token on this contract, or null when the request or rebuild failed.
   */
  private static async fetchSvgCard(candidate: Candidate, fullName: string): Promise<EthIdNftCard | 'unknown' | null> {
    const url = this.buildImageUrl(candidate.contract, candidate.tokenId, 'svg');
    const response = await this.download(url, 'image/svg+xml');
    if (response === 'not-found') return 'unknown';
    if (!response || !response.contentType.includes('svg')) return null;

    const svg = response.buffer.toString('utf-8');
    if (this.isUnknownNameCard(svg)) return 'unknown';

    try {
      const instanceId = `nft${(++this.cardCounter).toString(36)}`;
      const html = await buildEthIdSvgCard(svg, instanceId);
      if (!html) return 'unknown';
      return { format: 'svg', html, source: candidate.label };
    } catch (error: any) {
      logger.warn(`EthID SVG card rebuild failed for ${fullName}: ${error.message}`);
      return null;
    }
  }

  /**
   * EthID's placeholder for a token it cannot resolve to a name either has no
   * label at all or labels it with the bracketed hash, e.g. "[0x0000...0001].eth".
   */
  private static isUnknownNameCard(svg: string): boolean {
    const text = svg.match(/<text\b[^>]*>([\s\S]*?)<\/text>/);
    if (!text) return true;
    return /^\s*\[0x[0-9a-f]+(\.\.\.[0-9a-f]+)?\]/i.test(text[1]);
  }

  /**
   * PNG path: EthID's rasterised card as an <img> that fills its parent.
   */
  private static async fetchPngCard(candidate: Candidate): Promise<EthIdNftCard | null> {
    const url = this.buildImageUrl(candidate.contract, candidate.tokenId, 'png');
    const response = await this.download(url, 'image/png');
    if (!response || response === 'not-found' || !response.contentType.includes('image/')) return null;

    const dataUrl = `data:image/png;base64,${response.buffer.toString('base64')}`;
    return {
      format: 'png',
      html: `<img src="${dataUrl}" alt="ENS NFT" style="display:block;width:100%;height:100%;object-fit:cover">`,
      source: candidate.label
    };
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
   * Download one URL. Returns 'not-found' on HTTP 404, or null on any other
   * failure (network, timeout, other non-2xx, empty body).
   */
  private static async download(url: string, accept: string): Promise<{ buffer: Buffer; contentType: string } | 'not-found' | null> {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: this.TIMEOUT_MS,
        headers: { 'User-Agent': 'ENS-TwitterBot/1.0', 'Accept': accept }
      });

      const contentType = String(response.headers['content-type'] || '');
      const buffer = Buffer.from(response.data);
      if (buffer.length === 0) {
        logger.debug(`EthID returned an empty body for ${url}`);
        return null;
      }
      return { buffer, contentType };
    } catch (error: any) {
      const status = error.response?.status;
      logger.debug(`EthID request failed for ${url}: ${status ? `HTTP ${status}` : error.message}`);
      return status === 404 ? 'not-found' : null;
    }
  }
}
