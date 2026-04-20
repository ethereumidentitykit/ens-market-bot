# QuickNode Stream Filter - ENS Renewals Monitoring

This document describes the QuickNode Streams filter function used to monitor ENS domain renewals via the ETH Registrar Controller events.

## Overview

The filter listens for `NameRenewed` events from ENS Registrar Controller contracts (legacy, current, and newest) and forwards them. Unlike the registration filter, the **per-event price filter is loose** (single-name renewals are typically tiny). The bot does its own per-transaction aggregation downstream — a bulk renewal of 100 names becomes one tweet at the application layer, with the threshold check applied to the **total transaction cost**.

## Configuration

### ENS Registrar Controller Contracts

Same three controllers as the registration filter (renewals fire from the same contracts):

| Contract Address | Label | Notes |
|-----------------|-------|-------|
| `0x283af0b28c62c092c9727f1ee09c02ca627eb7f5` | `ens_controller_first` | Legacy controller (4-arg event) |
| `0x253553366da8546fc250f225fe3d25d0c782303b` | `ens_controller_current` | Current controller (4-arg event) |
| `0x59e16fccd424cc24e280be16e11bcd56fb0ce547` | `ens_controller_newest` | Newest controller (5-arg event with referrer) |

> **Note on bulk renewal contracts.** ENS's official `BulkRenewal` contract (and any third-party bulk renewal services like `ensbatcher`, marketplace bulk-renewal flows, etc.) ultimately call `renew()` on one of the three controllers above per name. The `NameRenewed` events still emit from the controller addresses, so monitoring just these three is sufficient to capture all bulk renewal activity.

### Per-Event Price Filter

- **Minimum per-event cost**: `0` (no per-event filter — accept everything)
- The bot aggregates renewals by `transaction_hash` and applies a per-tx threshold downstream
- Setting this to 0 means even tiny single renewals are forwarded; the bot decides whether to tweet

If you want to reduce webhook traffic at the QuickNode layer (e.g., to skip lone $5 renewals that will never be tweeted on their own), you can raise this to e.g. `10_000_000_000_000_000n` (0.01 ETH). But be careful: this will also drop tiny per-name costs that are part of a high-value bulk renewal. **Recommended: keep at 0 and let the bot filter.**

## Event ABIs

The filter supports three different `NameRenewed` event formats:

### Legacy Controller (4 arguments)

```solidity
event NameRenewed(
    string name,           // ENS label (e.g., "vitalik")
    bytes32 indexed label, // keccak256 hash of name
    uint256 cost,          // Total renewal cost in wei
    uint256 expires        // New expiration timestamp
);
```

### Current Controller (4 arguments — same shape as legacy)

```solidity
event NameRenewed(
    string name,           // ENS label
    bytes32 indexed label, // keccak256 hash of name
    uint256 cost,          // Total renewal cost in wei
    uint256 expires        // New expiration timestamp
);
```

### Newest Controller (5 arguments with referrer)

```solidity
event NameRenewed(
    string label,              // ENS label (note: field renamed from 'name')
    bytes32 indexed labelhash, // keccak256 hash (note: field renamed from 'label')
    uint256 cost,              // Total renewal cost in wei
    uint256 expires,           // New expiration timestamp
    bytes32 referrer           // Referrer identifier (affiliate tracking)
);
```

### Important Differences vs `NameRegistered`

| Difference | NameRegistered | NameRenewed |
|---|---|---|
| `owner` field | ✅ Present (indexed) | ❌ **Not in event** — must be looked up separately |
| Cost split | `baseCost + premium` (current/newest) | Single `cost` field (no premium) |
| Renewer identity | `owner` is the new holder | **`tx.from`** is the renewer (anyone can renew anyone's name) |

The application layer (`QuickNodeRenewalService`) handles owner lookup at processing time via the ENS subgraph. Renewer is read from `tx.from`.

## Filter Logic

### Step 1: Collect Receipts
Walks the stream data structure to extract transaction receipts.

### Step 2: Decode Events
Uses `decodeEVMReceipts()` with all three `NameRenewed` ABIs.

### Step 3: Field Extraction

The filter handles naming differences across controller versions (same robustness pattern as the registration filter):

| Field | Legacy | Current | Newest |
|-------|--------|---------|--------|
| Name string | `name` | `name` | `label` |
| Label hash | `label` | `label` | `labelhash` |
| Cost | `cost` | `cost` | `cost` |
| Referrer | N/A | N/A | `referrer` |

### Step 4: Filter Criteria

1. **Contract Filter**: Only process events from labeled ENS controller contracts
2. **No price filter** (or very low minimum) — defer to per-tx aggregation downstream

### Step 5: Output Structure

```json
{
  "nameRenewed": [
    {
      "txHash": "0x...",
      "blockNumber": "0x...",
      "from": "0x...",
      "logIndex": 0,
      "contract": "0x253553366da8546fc250f225fe3d25d0c782303b",
      "contractLabel": "ens_controller_current",
      "name": "vitalik",
      "label": "0xaf2caa1c2ca1d027f1ac823b529d0a67cd144264b2789fa2ea4d63a67c7103cc",
      "cost": "5000000000000000",
      "expires": "1735689600",
      "referrer": null,
      "totalCostWei": "5000000000000000",
      "totalCostEth": "0.005"
    }
  ]
}
```

The `from` field carries the transaction sender (= renewer). The bot uses this as `renewer_address`.

## Full Filter Code

```javascript
function main(stream) {
  // --- ABIs (exact per controllers) ---
  const ENS_RENEWAL_ABI = [
    // Legacy controller (4 args, no owner)
    { type: 'event', name: 'NameRenewed', anonymous: false, inputs: [
      { indexed: false, name: 'name',    type: 'string'  },
      { indexed: true,  name: 'label',   type: 'bytes32' },
      { indexed: false, name: 'cost',    type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' }
    ]},
    // Current controller (4 args, no owner — same shape)
    // Note: same ABI as legacy; included separately for clarity but decodeEVMReceipts
    // will match either signature against the 4-arg form.
    { type: 'event', name: 'NameRenewed', anonymous: false, inputs: [
      { indexed: false, name: 'name',    type: 'string'  },
      { indexed: true,  name: 'label',   type: 'bytes32' },
      { indexed: false, name: 'cost',    type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' }
    ]},
    // Newest controller: 5 args, fields renamed (label vs name, labelhash vs label), + referrer
    { type: 'event', name: 'NameRenewed', anonymous: false, inputs: [
      { indexed: false, name: 'label',     type: 'string'  },
      { indexed: true,  name: 'labelhash', type: 'bytes32' },
      { indexed: false, name: 'cost',      type: 'uint256' },
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

  // Per-event minimum cost. Recommended: 0 (let the bot do per-tx aggregation).
  // If you want to drop tiny lone renewals at the stream layer, raise this.
  const MIN_PER_EVENT_WEI = 0n;

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
  const decoded = decodeEVMReceipts(receipts, [ENS_RENEWAL_ABI]) || [];

  const out = [];
  for (const r of decoded) {
    for (const log of (r.decodedLogs || [])) {
      // Only NameRenewed events
      if (log.name !== 'NameRenewed') continue;

      const contract = lc(log.address || '');
      if (LIMIT_TO_LABELLED && !CONTRACT_LABELS.has(contract)) continue;

      // robust field extraction (handles naming differences across versions)
      const nameCandidate  = getArg(log, 'name');       // string on first/current
      const labelStr       = getArg(log, 'label');      // string (newest) OR bytes32 (first/current)
      const labelHashField = getArg(log, 'labelhash');  // bytes32 (newest)

      const nameStr =
        (typeof labelStr === 'string' && !isBytes32(labelStr)) ? labelStr :
        (typeof nameCandidate === 'string' && !isBytes32(nameCandidate) && nameCandidate !== 'NameRenewed') ? nameCandidate :
        undefined;

      const labelHash =
        isBytes32(labelStr) ? labelStr :
        isBytes32(labelHashField) ? labelHashField :
        undefined;

      const cost     = getArg(log, 'cost');
      const expires  = getArg(log, 'expires');
      const referrer = getArg(log, 'referrer'); // bytes32 on newest only

      const costWei = cost !== undefined ? toBI(cost) : 0n;
      if (costWei < MIN_PER_EVENT_WEI) continue;

      out.push({
        txHash: r.transactionHash,
        blockNumber: r.blockNumber,
        from: r.from, // The renewer (= tx.from)
        logIndex: log.logIndex,
        contract,
        contractLabel: CONTRACT_LABELS.get(contract) || null,

        name: nameStr,                     // human-readable label (without .eth)
        label: labelHash,                  // bytes32 hash
        cost:    cost    !== undefined ? toDec(cost)    : undefined,
        expires: expires !== undefined ? toDec(expires) : undefined,
        referrer,

        totalCostWei: costWei.toString(),
        totalCostEth: ethStr(costWei)
      });
    }
  }

  return out.length ? { nameRenewed: out } : null;
}
```

## Webhook Endpoint

The webhook sends data to `/webhook/quicknode-renewals` on your server, which processes the `nameRenewed` array and:

1. Validates HMAC-SHA256 signature using `QUICKNODE_SECRET_RENEWALS`
2. Groups events by `txHash` (a single QuickNode webhook may carry events from multiple txs in one block)
3. For each tx group:
   - Looks up current owner per name via the ENS subgraph (in parallel)
   - Enriches metadata (image, description) via OpenSea → ENS Metadata fallback
   - Converts cost to USD via Alchemy price API
   - Inserts all rows for the tx in a single batched `INSERT ... ON CONFLICT (transaction_hash, log_index) DO NOTHING`
4. The PostgreSQL statement-level trigger fires once per distinct tx_hash → emits `pg_notify('new_renewal_tx', txHash)`
5. `DatabaseEventService` queues the tx for tweet generation

## Field Mapping to Database

| Webhook Field | Database Column | Notes |
|---------------|-----------------|-------|
| `txHash` | `transaction_hash` | Aggregation key for tx-level tweets |
| `logIndex` | `log_index` | Event index within the transaction; part of dedup key |
| `name` | `ens_name` | Label only (without .eth) |
| `name + ".eth"` | `full_name` | Full ENS name |
| `label` | `token_id` | bytes32 hash |
| `from` | `renewer_address` | Transaction sender (= the actor who paid) |
| (subgraph lookup) | `owner_address` | Current owner; nullable if lookup fails |
| `totalCostWei` | `cost_wei` | Per-name cost (always = single `cost` field — no baseCost/premium for renewals) |
| `totalCostEth` | `cost_eth` | Calculated |
| `expires` | `expires_at` | New expiration unix timestamp after this renewal |
| `contract` | `contract_address` | Which controller version |
| `contractLabel` | Used for logging | Identifies controller version |
| `referrer` | Logged only | Currently not stored (only present on newest controller) |

## Notes

- **No `owner` in the event.** Unlike `NameRegistered`, the `NameRenewed` event omits the owner. This is intentional — anyone can renew anyone else's name (gift renewals, third-party renewal services, marketplace bulk renewals). The bot uses `tx.from` as the renewer and looks up the current owner separately for tweet/AI context. Renewer ≠ owner is common.
- **No baseCost/premium split.** Renewals only have a single `cost` field. There's no premium pricing on renewals (premium only applies to grace-period registrations).
- **Bulk renewals.** A single tx can renew 100+ names via aggregator/marketplace contracts. The QuickNode webhook delivers all events from a block (potentially across multiple txs and many renewals each). The bot groups by `txHash` server-side and emits one tweet per tx.
- **Per-tx threshold downstream.** The bot's `autopost_renewals_min_eth_default` setting (default 0.1 ETH) is checked against the **total cost across all rows in the tx**, not per name. A bulk renewal where each name costs 0.005 ETH but the tx total is 0.5 ETH → tweets. A lone renewal of 0.005 ETH → does not tweet.
- **No premium club tiers.** Unlike sales/regs/bids, renewals don't use 999/10k club thresholds (decided: bulk renewals span many clubs so club logic doesn't map cleanly).
- **`name` field is the raw label** (e.g., "vitalik"), not the full domain ("vitalik.eth"). The bot appends ".eth" to construct `full_name`.
