# QuickNode Stream Filter - ENS Registrations Monitoring

This document describes the QuickNode Streams filter function used to monitor ENS domain registrations via the ETH Registrar Controller events.

## Overview

The filter listens for `NameRegistered` events from ENS Registrar Controller contracts (legacy, current, and newest) and filters registrations that meet a minimum ETH threshold.

## Configuration

### ENS Registrar Controller Contracts

| Contract Address | Label | Notes |
|-----------------|-------|-------|
| `0x283af0b28c62c092c9727f1ee09c02ca627eb7f5` | `ens_controller_first` | Legacy controller (5-arg event) |
| `0x253553366da8546fc250f225fe3d25d0c782303b` | `ens_controller_current` | Current controller (6-arg event) |
| `0x59e16fccd424cc24e280be16e11bcd56fb0ce547` | `ens_controller_newest` | Newest controller (7-arg event with referrer) |

### Spam Filter

- **Minimum ETH**: `0.04 ETH` (40,000,000,000,000,000 wei)
- For controllers with `baseCost` + `premium`, the sum is used

## Event ABIs

The filter supports three different `NameRegistered` event formats:

### Legacy Controller (5 arguments)
```solidity
event NameRegistered(
    string name,           // ENS label (e.g., "vitalik")
    bytes32 indexed label, // keccak256 hash of name
    address indexed owner, // Registrant address
    uint256 cost,          // Total registration cost in wei
    uint256 expires        // Expiration timestamp
);
```

### Current Controller (6 arguments)
```solidity
event NameRegistered(
    string name,            // ENS label
    bytes32 indexed label,  // keccak256 hash of name
    address indexed owner,  // Registrant address
    uint256 baseCost,       // Base registration cost
    uint256 premium,        // Premium (if any)
    uint256 expires         // Expiration timestamp
);
```

### Newest Controller (7 arguments with referrer)
```solidity
event NameRegistered(
    string label,              // ENS label (note: field renamed from 'name')
    bytes32 indexed labelhash, // keccak256 hash (note: field renamed)
    address indexed owner,     // Registrant address
    uint256 baseCost,          // Base registration cost
    uint256 premium,           // Premium (if any)
    uint256 expires,           // Expiration timestamp
    bytes32 referrer           // Referrer identifier
);
```

## Filter Logic

### Step 1: Collect Receipts
Walks the stream data structure to extract transaction receipts.

### Step 2: Decode Events
Uses `decodeEVMReceipts()` with the ENS ABIs to decode `NameRegistered` events across all three formats.

### Step 3: Field Extraction

The filter uses robust field extraction to handle naming differences across controller versions:

| Field | Legacy | Current | Newest |
|-------|--------|---------|--------|
| Name string | `name` | `name` | `label` |
| Label hash | `label` | `label` | `labelhash` |
| Cost | `cost` | `baseCost + premium` | `baseCost + premium` |
| Referrer | N/A | N/A | `referrer` |

### Step 4: Cost Calculation

```javascript
totalCost = (baseCost !== undefined || premium !== undefined) 
  ? baseCost + premium 
  : cost;
```

### Step 5: Filter Criteria

1. **Contract Filter**: Only process events from labeled ENS controller contracts
2. **Price Filter**: Require `totalCost ≥ 0.04 ETH`

### Step 6: Output Structure

```json
{
  "nameRegistered": [
    {
      "txHash": "0x...",
      "blockNumber": "0x...",
      "logIndex": 0,
      "contract": "0x253553366da8546fc250f225fe3d25d0c782303b",
      "contractLabel": "ens_controller_current",
      "name": "vitalik",
      "label": "0xaf2caa1c2ca1d027f1ac823b529d0a67cd144264b2789fa2ea4d63a67c7103cc",
      "owner": "0x...",
      "cost": undefined,
      "baseCost": "50000000000000000",
      "premium": "0",
      "expires": "1735689600",
      "referrer": undefined,
      "totalCostWei": "50000000000000000",
      "totalCostEth": "0.05"
    }
  ]
}
```

## Full Filter Code

```javascript
function main(stream) {
  // --- ABIs (exact per controllers) ---
  const ENS_ABI = [
    // Legacy controller (5 args): name, label, owner, cost, expires
    { type: 'event', name: 'NameRegistered', anonymous: false, inputs: [
      { indexed: false, name: 'name',  type: 'string'  },
      { indexed: true,  name: 'label', type: 'bytes32' },
      { indexed: true,  name: 'owner', type: 'address' },
      { indexed: false, name: 'cost',  type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' }
    ]},
    // Current controller (6 args): name, label, owner, baseCost, premium, expires
    { type: 'event', name: 'NameRegistered', anonymous: false, inputs: [
      { indexed: false, name: 'name',     type: 'string'  },
      { indexed: true,  name: 'label',    type: 'bytes32' },
      { indexed: true,  name: 'owner',    type: 'address' },
      { indexed: false, name: 'baseCost', type: 'uint256' },
      { indexed: false, name: 'premium',  type: 'uint256' },
      { indexed: false, name: 'expires',  type: 'uint256' }
    ]},
    // Newest controller (7 args): label, labelhash, owner, baseCost, premium, expires, referrer
    { type: 'event', name: 'NameRegistered', anonymous: false, inputs: [
      { indexed: false, name: 'label',     type: 'string'  },
      { indexed: true,  name: 'labelhash', type: 'bytes32' },
      { indexed: true,  name: 'owner',     type: 'address' },
      { indexed: false, name: 'baseCost',  type: 'uint256' },
      { indexed: false, name: 'premium',   type: 'uint256' },
      { indexed: false, name: 'expires',   type: 'uint256' },
      { indexed: false, name: 'referrer',  type: 'bytes32' }
    ]}
  ];

  // controllers (restrict)
  const CONTRACT_LABELS = new Map([
    ['0x283af0b28c62c092c9727f1ee09c02ca627eb7f5', 'ens_controller_first'],
    ['0x253553366da8546fc250f225fe3d25d0c782303b', 'ens_controller_current'],
    ['0x59e16fccd424cc24e280be16e11bcd56fb0ce547', 'ens_controller_newest'],
  ]);
  const LIMIT_TO_LABELLED = true;

  // price cutoff
  const MIN_TOTAL_WEI = 40_000_000_000_000_000n; // 0.04 ETH

  // helpers
  const lc = (x) => (x || '').toLowerCase();
  const toBI = (v) => (typeof v === 'bigint' ? v : BigInt(v));
  const toDec = (v) => (typeof v === 'bigint') ? v.toString() :
    (typeof v === 'string' && v.startsWith('0x')) ? BigInt(v).toString() : String(v);
  const isBytes32 = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);

  const getArg = (log, key) => {
    if (log?.args && typeof log.args === 'object' && Object.prototype.hasOwnProperty.call(log.args, key)) return log.args[key];
    if (log && Object.prototype.hasOwnProperty.call(log, key)) return log[key];
    if (Array.isArray(log?.params)) {
      const p = log.params.find((x) => x.name === key);
      if (p) return p.value;
    }
    return undefined;
  };

  const totalCostWei = (log) => {
    const base = getArg(log, 'baseCost');
    const prem = getArg(log, 'premium');
    const cost = getArg(log, 'cost');
    return (base !== undefined || prem !== undefined) ? toBI(base ?? 0) + toBI(prem ?? 0) : toBI(cost ?? 0);
  };

  const ethStr = (wei) => {
    const w = toBI(wei), int = w / 1000000000000000000n, frac = (w % 1000000000000000000n).toString().padStart(18,'0').replace(/0+$/,'');
    return frac ? `${int}.${frac}` : `${int}`;
  };

  // collect receipts
  const root = stream.data ?? stream;
  const receipts = [];
  (function walk(n){ if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n==='object' && Array.isArray(n.receipts)) receipts.push(...n.receipts); })(root);
  if (!receipts.length) return null;

  // decode
  const decoded = decodeEVMReceipts(receipts, [ENS_ABI]) || [];

  const out = [];
  for (const r of decoded) {
    for (const log of (r.decodedLogs || [])) {
      const contract = lc(log.address || '');
      if (LIMIT_TO_LABELLED && !CONTRACT_LABELS.has(contract)) continue;

      // robust field extraction
      const nameCandidate  = getArg(log, 'name');       // string on first/current
      const labelStr       = getArg(log, 'label');      // string (newest) OR bytes32 (first/current)
      const labelHashField = getArg(log, 'labelhash');  // bytes32 (newest)

      const nameStr =
        (typeof labelStr === 'string' && !isBytes32(labelStr)) ? labelStr :
        (typeof nameCandidate === 'string' && !isBytes32(nameCandidate) && nameCandidate !== 'NameRegistered') ? nameCandidate :
        undefined;

      const labelHash =
        isBytes32(labelStr) ? labelStr :
        isBytes32(labelHashField) ? labelHashField :
        undefined;

      const owner   = getArg(log, 'owner');
      const cost    = getArg(log, 'cost');
      const base    = getArg(log, 'baseCost');
      const prem    = getArg(log, 'premium');
      const expires = getArg(log, 'expires');
      const referrer= getArg(log, 'referrer'); // bytes32 on newest

      const totalWei = totalCostWei(log);
      if (totalWei < MIN_TOTAL_WEI) continue;

      out.push({
        txHash: r.transactionHash,
        blockNumber: r.blockNumber,
        logIndex: log.logIndex,
        contract,
        contractLabel: CONTRACT_LABELS.get(contract) || null,

        name: nameStr,                     // human-readable label
        label: labelHash,                  // bytes32 hash
        owner,
        cost:     cost !== undefined ? toDec(cost) : undefined,
        baseCost: base !== undefined ? toDec(base) : undefined,
        premium:  prem !== undefined ? toDec(prem) : undefined,
        expires:  expires !== undefined ? toDec(expires) : undefined,
        referrer,

        totalCostWei: totalWei.toString(),
        totalCostEth: ethStr(totalWei)
      });
    }
  }

  return out.length ? { nameRegistered: out } : null;
}
```

## Webhook Endpoint

The webhook sends data to `/webhook/quicknode-registrations` on your server, which processes the `nameRegistered` array and:

1. Validates HMAC-SHA256 signature using `QUICKNODE_SECRET_REGISTRATIONS`
2. Extracts ENS name from `name` field (already human-readable)
3. Uses `label` (bytes32) as the token ID for metadata lookup
4. Fetches ENS metadata (image, description) from ENS Metadata Service
5. Converts cost to USD via Alchemy price API
6. Stores registration in database
7. Triggers tweet generation

## Field Mapping to Database

| Webhook Field | Database Column | Notes |
|---------------|-----------------|-------|
| `txHash` | `transaction_hash` | |
| `name` | `ens_name` | Label only (without .eth) |
| `name + ".eth"` | `full_name` | Full ENS name |
| `label` | `token_id` | bytes32 hash |
| `owner` | `owner_address` | |
| `totalCostWei` | `cost_wei` | |
| `totalCostEth` | `cost_eth` | Calculated |
| `expires` | `expires_at` | Unix timestamp |
| `contractLabel` | Used for logging | Identifies controller version |
| `referrer` | Logged only | Currently not stored |

## Notes

- The filter handles three different ABI versions transparently
- Field names differ between controller versions (`name` vs `label`, `label` vs `labelhash`)
- Premium registrations include `baseCost + premium` for total cost
- The `referrer` field is new and used for affiliate tracking
- Block number is returned in hex format
- The `name` field is the raw label (e.g., "vitalik"), not the full domain ("vitalik.eth")

