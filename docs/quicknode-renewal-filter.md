# QuickNode Stream Filter - ENS Renewals Monitoring

This document describes the QuickNode Streams filter function used to monitor ENS domain renewals via the ETH Registrar Controller events.

## Overview

The filter listens for `NameRenewed` events from ENS Registrar Controller contracts (legacy, current, and newest) and forwards them. Unlike the registration filter (which filters per-event), this filter aggregates `cost` across all `NameRenewed` events sharing the same `txHash` and drops the entire transaction if the **total cost** is below a threshold. This mirrors what the bot does downstream and is safe for bulk renewals (a tx with 100 names at 0.001 ETH each = 0.1 ETH total still passes), while still cutting webhook traffic for lone single-name renewals.

## Configuration

### ENS Registrar Controller Contracts

Same three controllers as the registration filter (renewals fire from the same contracts):

| Contract Address | Label | Notes |
|-----------------|-------|-------|
| `0x283af0b28c62c092c9727f1ee09c02ca627eb7f5` | `ens_controller_first` | Legacy controller (4-arg event) |
| `0x253553366da8546fc250f225fe3d25d0c782303b` | `ens_controller_current` | Current controller (4-arg event) |
| `0x59e16fccd424cc24e280be16e11bcd56fb0ce547` | `ens_controller_newest` | Newest controller (5-arg event with referrer) |

> **Note on bulk renewal contracts.** ENS's official `BulkRenewal` contract (and any third-party bulk renewal services like `ensbatcher`, marketplace bulk-renewal flows, etc.) ultimately call `renew()` on one of the three controllers above per name. The `NameRenewed` events still emit from the controller addresses, so monitoring just these three is sufficient to capture all bulk renewal activity.

### Per-Tx Total Cost Filter

- **Minimum per-tx total cost**: `0.1 ETH` (`100_000_000_000_000_000n` wei)
- Costs are summed across all `NameRenewed` events that share the same `txHash` (and pass the contract filter), so a bulk renewal of 100 names at 0.001 ETH each = 0.1 ETH total → all rows are forwarded.
- A lone single-name renewal at 0.0001 ETH → dropped. A small bulk renewal totalling 0.05 ETH → dropped.
- This threshold matches the bot's `autopost_renewals_min_eth_default` (default `0.1`), so anything filtered here would also have been rejected downstream — the QuickNode-layer filter just saves the webhook round-trip, DB write, owner lookup, and metadata fetches.

If `autopost_renewals_min_eth_default` is changed in the bot, update `MIN_TX_TOTAL_WEI` in the filter to match (or set it lower, never higher — setting it higher would silently drop renewals the bot was configured to tweet).

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

1. **Contract Filter**: Only process events from labeled ENS controller contracts.
2. **Per-Tx Aggregation**: For each receipt (= one tx), sum `cost` across all `NameRenewed` events that passed the contract filter.
3. **Per-Tx Threshold**: Drop the entire tx (all rows) if the summed total is below `MIN_TX_TOTAL_WEI` (0.1 ETH). Otherwise, emit all rows for that tx.

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
  // IMPORTANT: only TWO ABI entries are needed for the three controllers because the
  // legacy and current controllers emit the IDENTICAL 4-arg event signature. Solidity
  // event signature hashes are computed from the type tuple only (names are ignored),
  // so adding both as separate entries produces a duplicate-signature collision that
  // QuickNode's decoder silently rejects, returning zero matches across all logs.
  const ENS_RENEWAL_ABI = [
    // Legacy + Current controllers (same signature: NameRenewed(string,bytes32,uint256,uint256))
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

  // Per-tx total cost minimum (sum of `cost` across all NameRenewed events sharing
  // the same txHash). Mirrors the bot's `autopost_renewals_min_eth_default` so any
  // tx that wouldn't be tweeted gets dropped here, saving the webhook round-trip,
  // DB write, owner lookup, and metadata fetches.
  // 100_000_000_000_000_000n = 0.1 ETH. If you change `autopost_renewals_min_eth_default`
  // in the bot, update this to match (or set lower — never higher, or you'll silently
  // drop renewals the bot was configured to tweet).
  const MIN_TX_TOTAL_WEI = 100_000_000_000_000_000n;

  // helpers
  const lc = (x) => (x || '').toLowerCase();
  const toBI = (v) => (typeof v === 'bigint' ? v : BigInt(v));
  const toDec = (v) => (typeof v === 'bigint') ? v.toString() :
    (typeof v === 'string' && v.startsWith('0x')) ? BigInt(v).toString() : String(v);
  const isBytes32 = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);

  // QuickNode's decodeEVMReceipts attaches decoded params as TOP-LEVEL fields on each
  // entry of receipt.decodedLogs (not nested under .args). So `log.cost`, `log.label`,
  // etc. are direct properties. There is NO event-name field on the decoded log — the
  // only way we know it's a NameRenewed event is that we only registered NameRenewed
  // in our ABI, so anything decoded must be one.
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
    // Each receipt `r` is one transaction. Build candidate rows for the tx, sum
    // their costs, then emit the whole batch only if the tx total clears the
    // threshold. This is the key difference vs sales/regs: bulk-renewal txs have
    // many cheap rows that individually look like junk but collectively are
    // tweetable, so we must aggregate before deciding.
    const txRows = [];
    let txTotalWei = 0n;

    for (const log of (r.decodedLogs || [])) {
      // Only ABI we registered is NameRenewed, so any decoded log here IS one.
      // (QuickNode's decoded log shape is flat — there's no `log.name === 'NameRenewed'`
      // event-name field to check; the parameter `name` value lives in log.name instead.)

      const contract = lc(log.address || '');
      if (LIMIT_TO_LABELLED && !CONTRACT_LABELS.has(contract)) continue;

      // Field name differs between controller versions:
      //   legacy/current:  log.name (string), log.label (bytes32)
      //   newest:          log.label (string), log.labelhash (bytes32), log.referrer (bytes32)
      // Disambiguate by inspecting whether `log.label` is a bytes32 hash or a label string.
      const nameCandidate  = log.name;       // string on legacy/current
      const labelField     = log.label;      // bytes32 on legacy/current; string on newest
      const labelHashField = log.labelhash;  // bytes32 on newest only

      const nameStr =
        (typeof labelField === 'string' && !isBytes32(labelField)) ? labelField :
        (typeof nameCandidate === 'string' && !isBytes32(nameCandidate)) ? nameCandidate :
        undefined;

      const labelHash =
        isBytes32(labelField) ? labelField :
        isBytes32(labelHashField) ? labelHashField :
        undefined;

      const cost     = log.cost;
      const expires  = log.expires;
      const referrer = log.referrer; // bytes32 on newest only

      const costWei = cost !== undefined ? toBI(cost) : 0n;
      txTotalWei += costWei;

      txRows.push({
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

    // Drop the whole tx if its summed cost is below threshold. This must happen
    // AFTER the per-log loop so bulk renewals (many cheap rows summing to a big
    // total) survive — applying the threshold per-log would drop them all.
    if (txRows.length && txTotalWei >= MIN_TX_TOTAL_WEI) {
      for (const row of txRows) out.push(row);
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
