# QuickNode Sales Filter - ENS Sales Monitoring

This document describes the QuickNode Streams filter function used to monitor ENS domain sales via Seaport (OpenSea) events.

## Overview

The filter listens for `OrderFulfilled` events from Seaport contracts (v1.5 and v1.6) and filters for ENS-related NFT trades that meet a minimum value threshold (ETH/WETH or USDC/USDT).

## Configuration

### Seaport Contracts

| Contract Address | Label |
|-----------------|-------|
| `0x00000000000000adc04c56bf30ac9d3c0aaf14dc` | `seaport_v1_5` |
| `0x0000000000000068f116a894984e2db1123eb395` | `seaport_v1_6` |

### Target NFT Contracts (ENS)

| Contract Address | Description |
|-----------------|-------------|
| `0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85` | ENS Base Registrar (OG Registry) |
| `0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401` | ENS NameWrapper |

### Spam Filter

- **Minimum ETH**: `0.04 ETH` (40,000,000,000,000,000 wei) — counts native ETH and WETH
- **Minimum Stablecoin**: `100 USDC/USDT` (100,000,000 units at 6 decimals)
- Orders meeting EITHER threshold pass through

## Event ABI

```solidity
event OrderFulfilled(
    bytes32 orderHash,
    address indexed offerer,
    address indexed zone,
    address recipient,
    SpentItem[] offer,
    ReceivedItem[] consideration
);

struct SpentItem {
    uint8 itemType;
    address token;
    uint256 identifier;
    uint256 amount;
}

struct ReceivedItem {
    uint8 itemType;
    address token;
    uint256 identifier;
    uint256 amount;
    address recipient;
}
```

### Item Types

| Value | Type |
|-------|------|
| 0 | Native ETH |
| 1 | ERC-20 |
| 2 | ERC-721 |
| 3 | ERC-1155 |
| 4 | ERC-721 with criteria |
| 5 | ERC-1155 with criteria |

## Filter Logic

### Step 1: Collect Receipts
Walks the stream data structure to extract transaction receipts.

### Step 2: Decode Events
Uses `decodeEVMReceipts()` with the Seaport ABI to decode `OrderFulfilled` events.

### Step 3: Filter Criteria

1. **Contract Filter**: Only process events from labeled Seaport contracts
2. **NFT Filter**: Require target ENS contract in `offer[]` or `consideration[]` with NFT itemType (2-5)
3. **Spam Filter**: Require ≥ 0.04 ETH (ETH + WETH) OR ≥ 100 USDC/USDT in the trade

### Step 4: Extract Fee Recipients

After filtering, extract fee recipients from the consideration array:
- Any consideration item where `recipient !== offerer` is a fee
- Calculate percentage: `(feeAmount / totalEthLikeWei) * 100`
- Include all fees (filtering for marketplaces happens in backend)

### Step 5: Output Structure

```json
{
  "orderFulfilled": [
    {
      "txHash": "0x...",
      "blockNumber": "0x...",
      "logIndex": 0,
      "contract": "0x0000000000000068f116a894984e2db1123eb395",
      "contractLabel": "seaport_v1_6",
      "orderHash": "0x...",
      "offerer": "0x...",
      "zone": "0x...",
      "recipient": "0x...",
      "offerRaw": [...],
      "considerationRaw": [...],
      "offer": [
        {
          "itemType": 2,
          "token": "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85",
          "identifier": "123456...",
          "amount": "1"
        }
      ],
      "consideration": [
        {
          "itemType": 0,
          "token": "0x0000000000000000000000000000000000000000",
          "identifier": "0",
          "amount": "50000000000000000",
          "recipient": "0x..."
        }
      ],
      "ethLikeWei": "50000000000000000",
      "ethLikeEth": "0.05",
      "minEthLikeWei": "40000000000000000",
      "stablecoinUnits": null,
      "stablecoinSymbol": null,
      "fee": {
        "recipient": "0x...",
        "amount": "2500000000000000",
        "percent": 5
      }
    }
  ]
}
```

**Notes**:
- `fee` is `null` if no fee recipients found (all consideration goes to offerer)
- `stablecoinUnits` and `stablecoinSymbol` are `null` for ETH/WETH-only trades
- For stablecoin trades, `ethLikeWei` will be `"0"` and `stablecoinUnits` holds the 6-decimal amount

## Full Filter Code

```javascript
function main(stream) {
  // --- ABI: OrderFulfilled (v1.5 & v1.6) ---
  const SEAPORT_ABI = [{
    type: 'event',
    name: 'OrderFulfilled',
    anonymous: false,
    inputs: [
      { indexed: false, name: 'orderHash',  type: 'bytes32' },
      { indexed: true,  name: 'offerer',    type: 'address' },
      { indexed: true,  name: 'zone',       type: 'address' },
      { indexed: false, name: 'recipient',  type: 'address' },
      { indexed: false, name: 'offer', type: 'tuple[]', components: [
        { name: 'itemType', type: 'uint8' },
        { name: 'token',    type: 'address' },
        { name: 'identifier', type: 'uint256' },
        { name: 'amount',   type: 'uint256' }
      ]},
      { indexed: false, name: 'consideration', type: 'tuple[]', components: [
        { name: 'itemType', type: 'uint8' },
        { name: 'token',    type: 'address' },
        { name: 'identifier', type: 'uint256' },
        { name: 'amount',   type: 'uint256' },
        { name: 'recipient', type: 'address' }
      ]}
    ]
  }];

  // --- Seaport contracts (restrict to these) ---
  const CONTRACT_LABELS = new Map([
    ['0x00000000000000adc04c56bf30ac9d3c0aaf14dc', 'seaport_v1_5'],
    ['0x0000000000000068f116a894984e2db1123eb395', 'seaport_v1_6'],
  ]);
  const LIMIT_TO_LABELLED = true;

  // --- Target NFT contracts (lowercased) ---
  const TARGET_CONTRACTS = new Set([
    '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85', // ENS Base Registrar
    '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401', // ENS NameWrapper
  ]);
  const REQUIRE_TARGET_CONTRACT = true;

  // --- ETH/WETH spam filter ---
  const MIN_WEI = 40_000_000_000_000_000n; // 0.04 ETH
  const ZERO  = '0x0000000000000000000000000000000000000000';
  const WETH  = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'.toLowerCase();

  // --- Stablecoin support ---
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
  const MIN_STABLECOIN_UNITS = 100_000_000n; // 100 USDC/USDT (6 decimals)

  // --- helpers ---
  const lc = (x) => (x || '').toLowerCase();
  const toDec = (v) => (typeof v === 'bigint') ? v.toString()
                    : (typeof v === 'number') ? String(v)
                    : (typeof v === 'string' && v.startsWith('0x')) ? BigInt(v).toString()
                    : String(v);
  const toBI = (v) => (typeof v === 'bigint') ? v : BigInt(v);
  const parseTupleArray = (val, tupleLen, names) => {
    if (!val) return [];
    if (Array.isArray(val)) {
      if (val.length && typeof val[0] === 'object' && (names[0] in val[0] || 'itemType' in val[0])) {
        return val.map((t) => ({
          itemType: Number(t.itemType ?? t[names[0]] ?? t[0]),
          token: String(t.token ?? t[names[1]] ?? t[1]),
          identifier: toDec(t.identifier ?? t[names[2]] ?? t[2]),
          amount: toDec(t.amount ?? t[names[3]] ?? t[3]),
          ...(tupleLen === 5 ? { recipient: String(t.recipient ?? t[names[4]] ?? t[4]) } : {})
        }));
      }
      return val.map((t) => ({
        itemType: Number(t[0]),
        token: String(t[1]),
        identifier: toDec(t[2]),
        amount: toDec(t[3]),
        ...(tupleLen === 5 ? { recipient: String(t[4]) } : {})
      }));
    }
    if (typeof val === 'string') {
      const parts = val.split(',').map((s) => s.trim());
      const out = [];
      for (let i = 0; i + tupleLen - 1 < parts.length; i += tupleLen) {
        const p = parts.slice(i, i + tupleLen);
        out.push({
          itemType: Number(p[0]),
          token: p[1],
          identifier: toDec(p[2]),
          amount: toDec(p[3]),
          ...(tupleLen === 5 ? { recipient: p[4] } : {})
        });
      }
      return out;
    }
    return [];
  };
  const NFT_ITEM_TYPES = new Set([2, 3, 4, 5]);
  const hasTargetNft = (arr) => Array.isArray(arr) && arr.some(e =>
    TARGET_CONTRACTS.has(lc(e.token)) && NFT_ITEM_TYPES.has(Number(e.itemType))
  );
  const isEthLike = (e) =>
    (Number(e.itemType) === 0 && lc(e.token) === lc(ZERO)) || // native ETH
    (Number(e.itemType) === 1 && lc(e.token) === WETH);       // WETH (ERC-20)
  const isStablecoin = (e) =>
    Number(e.itemType) === 1 && (lc(e.token) === USDC || lc(e.token) === USDT);
  const sumEthLikeWei = (offer, consideration) => {
    let s = 0n;
    for (const a of (offer || [])) if (isEthLike(a)) s += toBI(a.amount);
    for (const a of (consideration || [])) if (isEthLike(a)) s += toBI(a.amount);
    return s;
  };
  const sumStablecoinUnits = (offer, consideration) => {
    let s = 0n;
    for (const a of (offer || [])) if (isStablecoin(a)) s += toBI(a.amount);
    for (const a of (consideration || [])) if (isStablecoin(a)) s += toBI(a.amount);
    return s;
  };
  const stablecoinSymbol = (offer, consideration) => {
    for (const a of [...(offer || []), ...(consideration || [])]) {
      if (!isStablecoin(a)) continue;
      return lc(a.token) === USDC ? 'USDC' : 'USDT';
    }
    return null;
  };
  const formatEth = (wei) => {
    const w = toBI(wei);
    const int = w / 1000000000000000000n;
    const frac = (w % 1000000000000000000n).toString().padStart(18, '0').replace(/0+$/, '');
    return frac ? `${int}.${frac}` : `${int}`;
  };

  // --- collect receipts (Receipts / Block-with-Receipts) ---
  const root = stream.data ?? stream;
  const receipts = [];
  (function walk(n){
    if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object' && Array.isArray(n.receipts)) receipts.push(...n.receipts);
  })(root);
  if (!receipts.length) return null;

  // --- decode ---
  const decoded = decodeEVMReceipts(receipts, [SEAPORT_ABI]) || [];

  const out = [];
  for (const r of decoded) {
    const dlogs = r?.decodedLogs || [];
    for (const log of dlogs) {
      if (log?.name !== 'OrderFulfilled') continue;

      const contract = lc(log.address || '');
      if (LIMIT_TO_LABELLED && !CONTRACT_LABELS.has(contract)) continue;

      const ev = (log.args && typeof log.args === 'object') ? log.args : log;

      // raw & parsed arrays (non-destructive)
      const offerRaw = ev.offer;
      const considerationRaw = ev.consideration;
      const offer = parseTupleArray(offerRaw, 4, ['itemType','token','identifier','amount']);
      const consideration = parseTupleArray(considerationRaw, 5, ['itemType','token','identifier','amount','recipient']);

      // Require target NFT somewhere in the trade
      if (REQUIRE_TARGET_CONTRACT && !(hasTargetNft(offer) || hasTargetNft(consideration))) continue;

      // Spam filter: require >= 0.04 ETH OR >= 100 USDC/USDT
      const ethLikeWei = sumEthLikeWei(offer, consideration);
      const scUnits = sumStablecoinUnits(offer, consideration);
      if (ethLikeWei < MIN_WEI && scUnits < MIN_STABLECOIN_UNITS) continue;

      // Determine the payment currency for fee calculation
      const paymentTotal = ethLikeWei > 0n ? ethLikeWei : scUnits;
      const isPaymentEth = ethLikeWei > 0n;
      const isPayment = (e) => isPaymentEth ? isEthLike(e) : isStablecoin(e);

      // Extract fee recipient: any payment-currency consideration where recipient !== offerer
      const offererLc = lc(ev.offerer);
      let fee = null;
      for (const c of consideration) {
        if (!isPayment(c)) continue;
        const recipientLc = lc(c.recipient);
        if (recipientLc === offererLc) continue;
        
        const feeAmount = toBI(c.amount);
        const percent = paymentTotal > 0n 
          ? Number((feeAmount * 10000n) / paymentTotal) / 100
          : 0;
        
        fee = {
          recipient: c.recipient,
          amount: feeAmount.toString(),
          percent
        };
        break;
      }

      const scSym = stablecoinSymbol(offer, consideration);

      out.push({
        txHash: r.transactionHash,
        blockNumber: r.blockNumber,
        logIndex: log.logIndex,
        contract,
        contractLabel: CONTRACT_LABELS.get(contract) || null,
        orderHash: ev.orderHash,
        offerer: ev.offerer,
        zone: ev.zone,
        recipient: ev.recipient,
        offerRaw,
        considerationRaw,
        offer,
        consideration,
        ethLikeWei: ethLikeWei.toString(),
        ethLikeEth: formatEth(ethLikeWei),
        minEthLikeWei: MIN_WEI.toString(),
        stablecoinUnits: scUnits > 0n ? scUnits.toString() : null,
        stablecoinSymbol: scSym,
        fee
      });
    }
  }

  return out.length ? { orderFulfilled: out } : null;
}
```

## Webhook Endpoint

The webhook sends data to `/webhook/salesv2` on your server, which processes the `orderFulfilled` array and:

1. Validates HMAC-SHA256 signature using `QUICKNODE_SECRET_SALES`
2. Extracts ENS token IDs from offer/consideration
3. Resolves ENS names via metadata service
4. Stores sales in database
5. Triggers tweet generation

## Notes

- Both `offer` and `consideration` are checked for ENS NFTs to handle both buy and sell orders
- WETH is treated equivalent to ETH for minimum threshold calculation
- USDC and USDT are recognized as valid payment currencies with a separate minimum threshold
- Raw arrays are preserved alongside parsed arrays for debugging
- Block number is returned in hex format

