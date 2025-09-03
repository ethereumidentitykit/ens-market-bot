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
}
