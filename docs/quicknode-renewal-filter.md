# QuickNode Stream Filter - ENS Renewals Monitoring

Monitor `NameRenewed` from all three V1 controllers, the V2 ETHRegistrar, and ETHRenewerV1. The webhook remains `/webhook/quicknode-renewals` with a `nameRenewed` array.

The mainnet addresses and event ABIs below are from the [ENS deployments page](https://docs.ens.domains/learn/deployments/) and its pinned [`contracts-v2` deployment commit](https://github.com/ensdomains/contracts-v2/tree/4f47cbcc11462fb413196e6b5c0f8090247a6c08/contracts/deployments/mainnet). ENS currently documents mainnet V2 as deployed ahead of launch; V1 remains supported. This filter is for **Ethereum mainnet**, not Sepolia.

V2 supports ERC20 payments, initially [USDC and DAI](https://docs.ens.domains/ensv2/eth-registrar/#multi-token-payments). Amounts are in each token's smallest unit (USDC: 6 decimals, DAI: 18). Never treat those amounts as ETH wei, use transaction value as the payment, or apply an ETH cutoff before currency conversion.

## Contracts

| Address | Label | Role |
|---|---|---|
| `0x283af0b28c62c092c9727f1ee09c02ca627eb7f5` | `ens_controller_first` | Legacy V1 controller |
| `0x253553366da8546fc250f225fe3d25d0c782303b` | `ens_controller_current` | Wrapped V1 controller |
| `0x59e16fccd424cc24e280be16e11bcd56fb0ce547` | `ens_controller_newest` | Latest V1 controller |
| `0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81` | `ens_v2_registrar` | V2 registrations and renewals |
| `0x56c447f308f463a01121c41e72b0e7e7557fcb68` | `ens_v2_renewer_v1` | ERC20 renewals of names still in V1 |

The V2 `.eth` registry is `0xf60aba43e1f7f3dab1186ff03b561401c9df85e2`. The V1 BaseRegistrar is `0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85`.

Bulk-renewal helpers call one of these contracts; the paid events emit from the controller or renewer, not the helper. `ExpiryUpdated` on the registry and V1 BaseRegistrar bookkeeping events are not payment events and are not included in the decoder.

## Event and payload mapping

V1 keeps its existing four-argument `NameRenewed(string,bytes32,uint256,uint256)` and newest five-argument version with `referrer`. Legacy/current share one ABI entry because their signatures are identical. V1-only transactions pass when their combined renewal cost is at least **0.1 ETH**; all rows in a qualifying bulk transaction are forwarded, even if each name costs less than the threshold. Keep `MIN_TX_TOTAL_WEI` at or below the backend's configured renewal threshold.

Both V2 contracts emit the deployed signature:

```solidity
event NameRenewed(
    uint256 indexed tokenId, string label, uint64 duration, uint64 newExpiry,
    address paymentToken, bytes32 indexed referrer, uint256 amount
);
```

V2 emits the common transaction fields (`txHash`, `blockNumber`, `from`, `logIndex`, `contract`, `contractLabel`) plus:

| Field | Meaning |
|---|---|
| `protocolVersion` | `2` (the event/payment protocol) |
| `name` | Raw label, without `.eth`; backend derives labelhash |
| `tokenId` | Decimal V2 registry token ID exactly as emitted |
| `registryAddress` | V2 ETHRegistry for ETHRegistrar; V1 BaseRegistrar for ETHRenewerV1 |
| `paymentToken`, `totalCostRaw` | ERC20 address and decimal amount in that token's smallest units |
| `duration`, `expires` | Extension duration and actual name expiry, in seconds |
| `reservationExpires` | ETHRenewerV1 only: `newExpiry` of the V2 reservation, including its migration bonus |
| `referrer` | Original indexed referrer |
| `blockTimestamp` | Block timestamp, when included by the stream |

`tokenId` on ETHRenewerV1 refers to a **V2 reservation**, while the renewed name is still held in V1. The backend must use `keccak256(name)` for its V1 asset/owner lookup, not pair that emitted reservation ID with the V1 BaseRegistrar. For ETHRenewerV1, `expires` comes from a matching V1 wrapper-sync event; if absent, the backend must query the V1 expiry. Its emitted `newExpiry` includes a migration bonus and must not be used as the V1 name expiry. Neither renewal event contains the owner; `from` is the transaction sender, not necessarily the owner.

V2 rows omit `cost`, `totalCostWei` and `totalCostEth`. Every transaction containing V2 rows is forwarded in full so the backend can convert each payment and apply its threshold to the combined ETH-equivalent amount. ETHRenewerV1 also synchronizes NameWrapper by calling the wrapped V1 controller with zero duration, producing an extra zero-cost V1 renewal. The filter removes only matching zero-cost wrapped-controller rows; independent paid renewals remain.

## Full Filter Code

Paste this complete function into the QuickNode renewal stream. `decodeEVMReceipts` is provided by QuickNode.

```javascript
function main(stream) {
  // Legacy/current share one ABI entry: duplicate signatures break QuickNode decoding.
  // Only NameRenewed signatures are decoded; flat log.name may be the label itself.
  const ENS_RENEWAL_ABI = [
    { type: 'event', name: 'NameRenewed', anonymous: false, inputs: [
      { indexed: false, name: 'name', type: 'string' },
      { indexed: true, name: 'label', type: 'bytes32' },
      { indexed: false, name: 'cost', type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' }
    ]},
    { type: 'event', name: 'NameRenewed', anonymous: false, inputs: [
      { indexed: false, name: 'label', type: 'string' },
      { indexed: true, name: 'labelhash', type: 'bytes32' },
      { indexed: false, name: 'cost', type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' },
      { indexed: false, name: 'referrer', type: 'bytes32' }
    ]},
    { type: 'event', name: 'NameRenewed', anonymous: false, inputs: [
      { indexed: true, name: 'tokenId', type: 'uint256' },
      { indexed: false, name: 'label', type: 'string' },
      { indexed: false, name: 'duration', type: 'uint64' },
      { indexed: false, name: 'newExpiry', type: 'uint64' },
      { indexed: false, name: 'paymentToken', type: 'address' },
      { indexed: true, name: 'referrer', type: 'bytes32' },
      { indexed: false, name: 'amount', type: 'uint256' }
    ]}
  ];

  const V2_REGISTRAR = '0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81';
  const V2_RENEWER_V1 = '0x56c447f308f463a01121c41e72b0e7e7557fcb68';
  const V2_REGISTRY = '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2';
  const V1_REGISTRAR = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
  const V1_WRAPPED_CONTROLLER = '0x253553366da8546fc250f225fe3d25d0c782303b';
  const CONTRACT_LABELS = new Map([
    ['0x283af0b28c62c092c9727f1ee09c02ca627eb7f5', 'ens_controller_first'],
    [V1_WRAPPED_CONTROLLER, 'ens_controller_current'],
    ['0x59e16fccd424cc24e280be16e11bcd56fb0ce547', 'ens_controller_newest'],
    [V2_REGISTRAR, 'ens_v2_registrar'],
    [V2_RENEWER_V1, 'ens_v2_renewer_v1'],
  ]);

  const lc = (value) => typeof value === 'string' ? value.toLowerCase() : '';
  const toDec = (value) => value === undefined ? undefined : BigInt(value).toString();
  const getArg = (log, key) => {
    if (log.args && Object.prototype.hasOwnProperty.call(log.args, key)) return log.args[key];
    if (Array.isArray(log.params)) {
      const param = log.params.find((p) => p.name === key);
      if (param) return param.value;
    }
    return log[key]; // QuickNode normally flattens decoded arguments onto the log.
  };
  const ethStr = (wei) => {
    const fraction = (wei % 1000000000000000000n).toString().padStart(18, '0').replace(/0+$/, '');
    return `${wei / 1000000000000000000n}${fraction ? '.' + fraction : ''}`;
  };

  // Keep the containing block's timestamp when the stream includes block data.
  // Receipts alone do not contain it. Never substitute the processing time.
  const receipts = [];
  const blockTimestamps = new Map();
  const seenReceipts = new Set();
  function collect(node, inheritedTimestamp) {
    if (Array.isArray(node)) {
      node.forEach((item) => collect(item, inheritedTimestamp));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const timestamp = node.block?.timestamp ?? node.timestamp ?? inheritedTimestamp;
    if (node.transactionHash && Array.isArray(node.logs)) {
      const txHash = lc(node.transactionHash);
      if (timestamp !== undefined) blockTimestamps.set(txHash, toDec(timestamp));
      if (!seenReceipts.has(txHash)) {
        seenReceipts.add(txHash);
        receipts.push(node);
      }
      return;
    }
    for (const value of Object.values(node)) collect(value, timestamp);
  }
  collect(stream.data ?? stream);
  if (!receipts.length) return null;
  const receiptCopies = () => receipts.map((receipt) => ({ ...receipt }));
  const context = (receipt, log, contract) => ({
    txHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber,
    blockTimestamp: blockTimestamps.get(lc(receipt.transactionHash)),
    from: receipt.from,
    logIndex: log.logIndex,
    contract,
    contractLabel: CONTRACT_LABELS.get(contract),
  });

  const MIN_TX_TOTAL_WEI = 100_000_000_000_000_000n; // V1-only transactions: 0.1 ETH.
  const decoded = decodeEVMReceipts(receiptCopies(), [ENS_RENEWAL_ABI]) || [];
  const transactions = new Map();
  for (const receipt of decoded) {
    const key = lc(receipt.transactionHash);
    const tx = transactions.get(key) || { rows: [], totalWei: 0n, hasV2: false };
    for (const log of (receipt.decodedLogs || [])) {
      const contract = lc(log.address);
      if (!CONTRACT_LABELS.has(contract)) continue;
      const tokenId = getArg(log, 'tokenId');
      const paymentToken = getArg(log, 'paymentToken');
      if (contract === V2_REGISTRAR || contract === V2_RENEWER_V1) {
        if (tokenId === undefined || paymentToken === undefined) continue;
        const name = getArg(log, 'label');
        tx.hasV2 = true;
        tx.rows.push({
          ...context(receipt, log, contract),
          protocolVersion: 2,
          name,
          tokenId: toDec(tokenId), // Emitted V2 registry ID, including V1 renewal reservations.
          registryAddress: contract === V2_RENEWER_V1 ? V1_REGISTRAR : V2_REGISTRY,
          duration: toDec(getArg(log, 'duration')),
          expires: contract === V2_REGISTRAR ? toDec(getArg(log, 'newExpiry')) : undefined,
          reservationExpires: contract === V2_RENEWER_V1 ? toDec(getArg(log, 'newExpiry')) : undefined,
          referrer: getArg(log, 'referrer'),
          paymentToken: lc(paymentToken),
          totalCostRaw: toDec(getArg(log, 'amount')),
        });
        continue;
      }
      if (tokenId !== undefined || paymentToken !== undefined) continue;
      const labelHash = getArg(log, 'labelhash');
      const costWei = BigInt(getArg(log, 'cost') ?? 0);
      tx.totalWei += costWei;
      tx.rows.push({
        ...context(receipt, log, contract),
        name: labelHash !== undefined ? getArg(log, 'label') : getArg(log, 'name'),
        label: labelHash ?? getArg(log, 'label'),
        cost: costWei.toString(),
        expires: toDec(getArg(log, 'expires')),
        referrer: getArg(log, 'referrer'),
        totalCostWei: costWei.toString(),
        totalCostEth: ethStr(costWei),
      });
    }
    transactions.set(key, tx);
  }

  const out = [];
  for (const tx of transactions.values()) {
    // Keep the entire mixed-currency tx for backend conversion and aggregation.
    if (!tx.hasV2 && tx.totalWei < MIN_TX_TOTAL_WEI) continue;
    const rows = tx.rows.sort((a, b) => {
      if (a.logIndex === undefined || b.logIndex === undefined) return 0;
      const first = BigInt(a.logIndex), second = BigInt(b.logIndex);
      return first < second ? -1 : first > second ? 1 : 0;
    });
    const awaitingSync = new Map();
    const wrapperSyncRows = new Set();
    for (const row of rows) {
      if (row.contract === V2_RENEWER_V1) {
        const queue = awaitingSync.get(row.name) || [];
        queue.push(row);
        awaitingSync.set(row.name, queue);
      } else if (row.contract === V1_WRAPPED_CONTROLLER && row.totalCostWei === '0') {
        // renewBatch emits all paid events before all wrapper sync events, in
        // the same per-name order. A queue also handles repeated labels.
        const queue = awaitingSync.get(row.name);
        if (queue?.length) {
          const paid = queue.shift();
          paid.expires = row.expires;
          paid.label = row.label;
          wrapperSyncRows.add(row);
        }
      }
    }
    for (const row of rows) {
      // Remove only the matched bookkeeping event, never independent renewals.
      if (!wrapperSyncRows.has(row)) out.push(row);
    }
  }
  return out.length ? { nameRenewed: out } : null;
}
```

## Verification

Run `node --test tests/quicknode-filters.test.cjs`. Tests cover deployed V2 ABIs, both renewal emitters, ERC20 units, per-transaction V1 thresholds, mixed payments, wrapper-sync duplicates and unrelated logs. Apply the updated filter in the QuickNode dashboard after deploying the backend that accepts the V2 payload.
