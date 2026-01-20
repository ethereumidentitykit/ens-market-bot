/**
 * Contract addresses to monitor for NFT sales
 * These are public blockchain addresses, no need for environment variables
 */
export const MONITORED_CONTRACTS = [
  {
    address: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
    name: 'ENS NameWrapper',
    displayName: 'NameWrapper', // For tweets
    hashtag: 'ENS'
  },
  {
    address: '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85', 
    name: 'ENS OG Registry',
    displayName: 'ENS', // For tweets
    hashtag: 'ENS'
  }
];

// Export just the addresses for backward compatibility
export const CONTRACT_ADDRESSES = MONITORED_CONTRACTS.map(c => c.address);

/**
 * Known marketplace fee recipient addresses
 * Used to filter out marketplace fees when displaying broker info in tweets
 * Addresses can be entered in any case - matching is case-insensitive
 */
const MARKETPLACE_FEE_ADDRESSES_RAW = [
  '0x0000a26b00c1F0DF003000390027140000fAa719', // OpenSea fee recipient
  // Add more marketplace addresses as discovered (any case is fine)
];

// Normalized Set for case-insensitive lookup
export const KNOWN_MARKETPLACE_FEE_ADDRESSES = new Set(
  MARKETPLACE_FEE_ADDRESSES_RAW.map(addr => addr.toLowerCase())
);

/**
 * Helper to check if address is a known marketplace (case-insensitive)
 */
export const isKnownMarketplaceFee = (address: string): boolean => {
  return KNOWN_MARKETPLACE_FEE_ADDRESSES.has(address.toLowerCase());
};
