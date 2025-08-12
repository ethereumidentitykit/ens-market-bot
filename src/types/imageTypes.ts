/**
 * Interface for mock image data used in image generation
 */
export interface MockImageData {
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
}
