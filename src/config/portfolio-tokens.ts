/**
 * Token whitelist and metadata for portfolio analysis
 * These are public blockchain addresses and standard token metadata
 */

export interface TokenMetadata {
  symbol: string;
  decimals: number;
}

/**
 * Whitelisted tokens to track for portfolio analysis
 * Only major stablecoins, WETH, wrapped ETH derivatives, and top DeFi tokens
 */
export const WHITELISTED_TOKENS: Record<string, string[]> = {
  'eth-mainnet': [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', // WBTC
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', // wstETH
    '0xae78736cd615f374d3085123a210448e74fc6393', // rETH
    '0x5a98fcbea516cf06857215779fd812ca3bef1b32', // LDO
    '0x514910771af9ca656af840dff83e8264ecf986ca', // LINK
    '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984', // UNI
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', // AAVE
    '0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2', // MKR
    '0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f', // SNX
    '0xd533a949740bb3306d119cc777fa900ba034cd52', // CRV
    '0xc00e94cb662c3520282e6f5717214004a7f26888', // COMP
    '0xba100000625a3754423978a60c9317c58a424e3d', // BAL
    '0x5f98805a4e8be255a32880fdec7f6728c6568ba0', // LUSD
    '0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0', // MATIC
    '0x111111111117dc0aa78b770fa6a738034120c302', // 1INCH
    '0xc18360217d8f7ab5e7c516566761ea12ce7f9d72', // ENS
    '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f'  // GHO
  ],
  'base-mainnet': [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
    '0x0555e30da8f98308edb960aa94c0db47230d2b9c', // WBTC
    '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH
    '0xe432cec96a5948189ae00b93ce28d83027e4d151', // LDO
    '0x453884bbdd48a2ca281f10557bdb90bb4593a73d', // MKR
    '0x22e6966b799c4d5b13be962e1d117b56327fda66'  // SNX
  ],
  'opt-mainnet': [
    '0x4200000000000000000000000000000000000006', // WETH
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    '0x68f180fcce6836688e9084f035309e29bf0a2095', // WBTC
    '0x1f32b1c2345538c0c6f582fcb022739c4a194ebb', // wstETH
    '0xfdb794692724153d1488ccdb0c56c252596735f', // LDO
    '0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6', // LINK
    '0x4200000000000000000000000000000000000042', // OP
    '0xab7badef82e9fe11f6f33f87bc9bc2aa27f2fcb5', // MKR
    '0x8700daec35af8ff88c16bdf0418774cb3d7599b4', // SNX
    '0x0994206dfe8de6ec6920ff4d779b0d950605fb53', // CRV
    '0xfe8b128ba8c78aabc59d4c64cee7ff28e9379921', // BAL
    '0xc40f949f8a4e094d1b49a23ea9241d289b7b2819', // LUSD
    '0x111111111117dc0aa78b770fa6a738034120c302'  // 1INCH
  ],
  'arb-mainnet': [
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
    '0xaf88d065e77c8ccc2239327c5edb3a432268e5831', // USDC
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', // WBTC
    '0x5979d7b546e38e414f7e9822514be443a4800529', // wstETH
    '0x13ad51ed4f1b7e9dc168d8a00cb3f4ddd85efa60', // LDO
    '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0', // UNI
    '0xba5ddd1f9d7f570dc94a51479a000e3bce967196', // AAVE
    '0x912ce59144191c1204e64559fe8253a0e49e6548', // ARB
    '0x11cdb42b0eb46d95f990bedd4695a6e3fa034978', // CRV
    '0x354a6da3fcde098f8389cad84b0182725c6c91dc', // COMP
    '0x040d1edc9569d4bab2d15287dc5a4f10f56a56b8', // BAL
    '0x93b346b6bc2548da6a1e7d98e9a4217652b29aea', // LUSD
    '0x111111111117dc0aa78b770fa6a738034120c302'  // 1INCH
  ],
  'zksync-mainnet': [
    '0x5aea5775959fbc2557cc8789bc1bf90a239d9a91', // WETH
    '0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4', // USDC
    '0x493257fd37edb34451f62edf8d2a0c418852ba4c', // USDT
    '0x4b9eb6c0b6ea15176bbf62841c6b2a8a398cb656'  // DAI
  ],
  'polygon-mainnet': [
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
    '0x2791bca1f2de4661ed88a30c99a7a9449aa84174', // USDC
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063', // DAI
    '0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6', // WBTC
    '0x1a1b87e058b8d9add50c8a1ede80376fde1e2e13', // wstETH
    '0xc3c7d422809852031b44ab29eec9f1eff2a58756', // LDO
    '0x6f7c932e7684666c9fd1d44527765433e01ff61d', // MKR
    '0x50b728d8d964fd00c2d0aad81718b71311fef68a', // SNX
    '0x172370d5cd63279efa6d502dab29171933a610af', // CRV
    '0x8505b9d2254ad4deb0916dd7d59ade791f0e25b4', // COMP
    '0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3', // BAL
    '0x0000000000000000000000000000000000001010', // MATIC
    '0x111111111117dc0aa78b770fa6a738034120c302'  // 1INCH
  ],
  'linea-mainnet': [
    '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', // WETH
    '0x176211869ca2b568f2a7d4ee941e073a821ee1ff', // USDC
    '0xa219439258ca9da29e9cc4ce5596924745e12b93', // USDT
    '0x4af15ec2a0bd43db75dd04e62faa3b8ef36b00d5', // DAI
    '0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4', // WBTC
    '0x2442bd7ae83b51f6664de408a385375fe4a84f52'  // MKR
  ]
};

/**
 * Token metadata (symbol and decimals) for known tokens
 * Format: 'network:address' => { symbol, decimals }
 */
export const TOKEN_METADATA: Record<string, TokenMetadata> = {
  // Ethereum Mainnet
  'eth-mainnet:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': { symbol: 'WETH', decimals: 18 },
  'eth-mainnet:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  'eth-mainnet:0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
  'eth-mainnet:0x6b175474e89094c44da98b954eedeac495271d0f': { symbol: 'DAI', decimals: 18 },
  'eth-mainnet:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': { symbol: 'WBTC', decimals: 8 },
  'eth-mainnet:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': { symbol: 'wstETH', decimals: 18 },
  'eth-mainnet:0xae78736cd615f374d3085123a210448e74fc6393': { symbol: 'rETH', decimals: 18 },
  'eth-mainnet:0x5a98fcbea516cf06857215779fd812ca3bef1b32': { symbol: 'LDO', decimals: 18 },
  'eth-mainnet:0x514910771af9ca656af840dff83e8264ecf986ca': { symbol: 'LINK', decimals: 18 },
  'eth-mainnet:0x1f9840a85d5af5bf1d1762f925bdaddc4201f984': { symbol: 'UNI', decimals: 18 },
  'eth-mainnet:0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9': { symbol: 'AAVE', decimals: 18 },
  'eth-mainnet:0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2': { symbol: 'MKR', decimals: 18 },
  'eth-mainnet:0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f': { symbol: 'SNX', decimals: 18 },
  'eth-mainnet:0xd533a949740bb3306d119cc777fa900ba034cd52': { symbol: 'CRV', decimals: 18 },
  'eth-mainnet:0xc00e94cb662c3520282e6f5717214004a7f26888': { symbol: 'COMP', decimals: 18 },
  'eth-mainnet:0xba100000625a3754423978a60c9317c58a424e3d': { symbol: 'BAL', decimals: 18 },
  'eth-mainnet:0x5f98805a4e8be255a32880fdec7f6728c6568ba0': { symbol: 'LUSD', decimals: 18 },
  'eth-mainnet:0x7d1afa7b718fb893db30a3abc0cfc608aacfebb0': { symbol: 'MATIC', decimals: 18 },
  'eth-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },
  'eth-mainnet:0xc18360217d8f7ab5e7c516566761ea12ce7f9d72': { symbol: 'ENS', decimals: 18 },
  'eth-mainnet:0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f': { symbol: 'GHO', decimals: 18 },

  // Base
  'base-mainnet:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  'base-mainnet:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
  'base-mainnet:0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
  'base-mainnet:0x50c5725949a6f0c72e6c4a641f24049a917db0cb': { symbol: 'DAI', decimals: 18 },
  'base-mainnet:0x0555e30da8f98308edb960aa94c0db47230d2b9c': { symbol: 'WBTC', decimals: 8 },
  'base-mainnet:0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452': { symbol: 'wstETH', decimals: 18 },
  'base-mainnet:0xe432cec96a5948189ae00b93ce28d83027e4d151': { symbol: 'LDO', decimals: 18 },
  'base-mainnet:0x453884bbdd48a2ca281f10557bdb90bb4593a73d': { symbol: 'MKR', decimals: 18 },
  'base-mainnet:0x22e6966b799c4d5b13be962e1d117b56327fda66': { symbol: 'SNX', decimals: 18 },

  // Optimism
  'opt-mainnet:0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18 },
  'opt-mainnet:0x0b2c639c533813f4aa9d7837caf62653d097ff85': { symbol: 'USDC', decimals: 6 },
  'opt-mainnet:0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': { symbol: 'USDT', decimals: 6 },
  'opt-mainnet:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  'opt-mainnet:0x68f180fcce6836688e9084f035309e29bf0a2095': { symbol: 'WBTC', decimals: 8 },
  'opt-mainnet:0x1f32b1c2345538c0c6f582fcb022739c4a194ebb': { symbol: 'wstETH', decimals: 18 },
  'opt-mainnet:0xfdb794692724153d1488ccdb0c56c252596735f': { symbol: 'LDO', decimals: 18 },
  'opt-mainnet:0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6': { symbol: 'LINK', decimals: 18 },
  'opt-mainnet:0x4200000000000000000000000000000000000042': { symbol: 'OP', decimals: 18 },
  'opt-mainnet:0xab7badef82e9fe11f6f33f87bc9bc2aa27f2fcb5': { symbol: 'MKR', decimals: 18 },
  'opt-mainnet:0x8700daec35af8ff88c16bdf0418774cb3d7599b4': { symbol: 'SNX', decimals: 18 },
  'opt-mainnet:0x0994206dfe8de6ec6920ff4d779b0d950605fb53': { symbol: 'CRV', decimals: 18 },
  'opt-mainnet:0xfe8b128ba8c78aabc59d4c64cee7ff28e9379921': { symbol: 'BAL', decimals: 18 },
  'opt-mainnet:0xc40f949f8a4e094d1b49a23ea9241d289b7b2819': { symbol: 'LUSD', decimals: 18 },
  'opt-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },

  // Arbitrum
  'arb-mainnet:0x82af49447d8a07e3bd95bd0d56f35241523fbab1': { symbol: 'WETH', decimals: 18 },
  'arb-mainnet:0xaf88d065e77c8ccc2239327c5edb3a432268e5831': { symbol: 'USDC', decimals: 6 },
  'arb-mainnet:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': { symbol: 'USDT', decimals: 6 },
  'arb-mainnet:0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': { symbol: 'DAI', decimals: 18 },
  'arb-mainnet:0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f': { symbol: 'WBTC', decimals: 8 },
  'arb-mainnet:0x5979d7b546e38e414f7e9822514be443a4800529': { symbol: 'wstETH', decimals: 18 },
  'arb-mainnet:0x13ad51ed4f1b7e9dc168d8a00cb3f4ddd85efa60': { symbol: 'LDO', decimals: 18 },
  'arb-mainnet:0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0': { symbol: 'UNI', decimals: 18 },
  'arb-mainnet:0xba5ddd1f9d7f570dc94a51479a000e3bce967196': { symbol: 'AAVE', decimals: 18 },
  'arb-mainnet:0x912ce59144191c1204e64559fe8253a0e49e6548': { symbol: 'ARB', decimals: 18 },
  'arb-mainnet:0x11cdb42b0eb46d95f990bedd4695a6e3fa034978': { symbol: 'CRV', decimals: 18 },
  'arb-mainnet:0x354a6da3fcde098f8389cad84b0182725c6c91dc': { symbol: 'COMP', decimals: 18 },
  'arb-mainnet:0x040d1edc9569d4bab2d15287dc5a4f10f56a56b8': { symbol: 'BAL', decimals: 18 },
  'arb-mainnet:0x93b346b6bc2548da6a1e7d98e9a4217652b29aea': { symbol: 'LUSD', decimals: 18 },
  'arb-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },

  // zkSync
  'zksync-mainnet:0x5aea5775959fbc2557cc8789bc1bf90a239d9a91': { symbol: 'WETH', decimals: 18 },
  'zksync-mainnet:0x3355df6d4c9c3035724fd0e3914de96a5a83aaf4': { symbol: 'USDC', decimals: 6 },
  'zksync-mainnet:0x493257fd37edb34451f62edf8d2a0c418852ba4c': { symbol: 'USDT', decimals: 6 },
  'zksync-mainnet:0x4b9eb6c0b6ea15176bbf62841c6b2a8a398cb656': { symbol: 'DAI', decimals: 18 },

  // Polygon
  'polygon-mainnet:0x7ceb23fd6bc0add59e62ac25578270cff1b9f619': { symbol: 'WETH', decimals: 18 },
  'polygon-mainnet:0x2791bca1f2de4661ed88a30c99a7a9449aa84174': { symbol: 'USDC', decimals: 6 },
  'polygon-mainnet:0xc2132d05d31c914a87c6611c10748aeb04b58e8f': { symbol: 'USDT', decimals: 6 },
  'polygon-mainnet:0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': { symbol: 'DAI', decimals: 18 },
  'polygon-mainnet:0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6': { symbol: 'WBTC', decimals: 8 },
  'polygon-mainnet:0x1a1b87e058b8d9add50c8a1ede80376fde1e2e13': { symbol: 'wstETH', decimals: 18 },
  'polygon-mainnet:0xc3c7d422809852031b44ab29eec9f1eff2a58756': { symbol: 'LDO', decimals: 18 },
  'polygon-mainnet:0x6f7c932e7684666c9fd1d44527765433e01ff61d': { symbol: 'MKR', decimals: 18 },
  'polygon-mainnet:0x50b728d8d964fd00c2d0aad81718b71311fef68a': { symbol: 'SNX', decimals: 18 },
  'polygon-mainnet:0x172370d5cd63279efa6d502dab29171933a610af': { symbol: 'CRV', decimals: 18 },
  'polygon-mainnet:0x8505b9d2254ad4deb0916dd7d59ade791f0e25b4': { symbol: 'COMP', decimals: 18 },
  'polygon-mainnet:0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3': { symbol: 'BAL', decimals: 18 },
  'polygon-mainnet:0x0000000000000000000000000000000000001010': { symbol: 'MATIC', decimals: 18 },
  'polygon-mainnet:0x111111111117dc0aa78b770fa6a738034120c302': { symbol: '1INCH', decimals: 18 },

  // Linea
  'linea-mainnet:0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f': { symbol: 'WETH', decimals: 18 },
  'linea-mainnet:0x176211869ca2b568f2a7d4ee941e073a821ee1ff': { symbol: 'USDC', decimals: 6 },
  'linea-mainnet:0xa219439258ca9da29e9cc4ce5596924745e12b93': { symbol: 'USDT', decimals: 6 },
  'linea-mainnet:0x4af15ec2a0bd43db75dd04e62faa3b8ef36b00d5': { symbol: 'DAI', decimals: 18 },
  'linea-mainnet:0x3aab2285ddcddad8edf438c1bab47e1a9d05a9b4': { symbol: 'WBTC', decimals: 8 },
  'linea-mainnet:0x2442bd7ae83b51f6664de408a385375fe4a84f52': { symbol: 'MKR', decimals: 18 }
};

