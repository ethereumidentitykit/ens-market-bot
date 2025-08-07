/**
 * Contract addresses to monitor for NFT sales
 * These are public blockchain addresses, no need for environment variables
 */
export const MONITORED_CONTRACTS = [
  {
    address: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
    name: 'Contract 1', // You can add collection names here later
  },
  {
    address: '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85', 
    name: 'ENS Domains', // This is actually ENS registry
  }
];

// Export just the addresses for backward compatibility
export const CONTRACT_ADDRESSES = MONITORED_CONTRACTS.map(c => c.address);
