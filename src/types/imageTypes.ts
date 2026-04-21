/**
 * Interface for image data used in image generation
 */
export interface ImageData {
  priceEth: number;
  priceUsd: number;
  ensName: string;
  nftImageUrl?: string;
  buyerAddress: string;
  buyerEns?: string;
  buyerAvatar?: string;
  sellerAddress: string;
  sellerEns?: string;
  sellerAvatar?: string;
  transactionHash: string;
  timestamp: Date;
  // NFT contract info for metadata fallbacks
  contractAddress?: string;
  tokenId?: string;
  currencySymbol?: string;
}

/**
 * One name's worth of data inside a renewal-tweet image.
 * Up to 4 of these are rendered as cards on the right side of the renewal image.
 */
export interface RenewalNameCard {
  ensName: string;        // Full name with .eth (e.g., "vitalik.eth")
  costEth: number;        // Per-name renewal cost in ETH
  nftImageUrl?: string;   // ENS NFT image (if available); placeholder used otherwise
  contractAddress?: string; // For metadata fallback
  tokenId?: string;        // For metadata fallback
}

/**
 * Image data for a renewal-tweet image.
 *
 * Layout differs from sales/regs/bids:
 * - Left side: total tx cost (USD + ETH) and "Owner" profile (renewer)
 * - Right side: dynamic grid of up to 4 cards
 *   - 1 name → single big card
 *   - 2 names → two cards side by side
 *   - 3 names → three cards in a row
 *   - 4+ names → 2x2 grid (top 3 + "+N more" overflow card)
 *
 * The "RENEWED" badge and "Owner" label are baked into the background PNGs (renewal-t1..t4.png).
 */
export interface RenewalImageData {
  totalCostEth: number;
  totalCostUsd: number;
  nameCount: number;        // Total names in the tx (used to compute extraCount)
  topNames: RenewalNameCard[];  // Length 1-3; sorted by costEth desc
  extraCount: number;       // = nameCount - topNames.length; 0 means no overflow card
  renewerEns: string;       // Display name for the renewer (ENS or shortened address)
  renewerAvatar?: string;   // ENS avatar URL (optional)
  transactionHash: string;
  timestamp: Date;
}
