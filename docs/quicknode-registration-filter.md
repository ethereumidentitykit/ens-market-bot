# QuickNode Stream Filter - ENS Registrations Monitoring

Monitor paid `NameRegistered` events from all three V1 controllers and the V2 ETHRegistrar. The webhook remains `/webhook/quicknode-registrations` with a `nameRegistered` array.

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

The V2 renewer is included in the address reference for clarity; it does not emit registration rows. Registry `LabelRegistered` events enrich a matching paid registration but never become standalone rows, so migration/reservation events are not reported as purchases.

## Event and payload mapping

V1 keeps the existing ABIs and fields: legacy `cost`, current/newest `baseCost + premium`, label hash in `label`, and the newest controller's `referrer`. A V1 registration must cost at least **0.04 ETH**.

V2 uses the deployed signature:

```solidity
event NameRegistered(
    uint256 indexed tokenId, string label, address owner, address subregistry,
    address resolver, uint64 duration, address paymentToken,
    bytes32 indexed referrer, uint256 base, uint256 premium
);
```

The filter forwards every paid V2 event for backend valuation and threshold checks. It emits the common transaction fields (`txHash`, `blockNumber`, `from`, `logIndex`, `contract`, `contractLabel`) plus:

| Field | Meaning |
|---|---|
| `protocolVersion` | `2` |
| `name` | Raw label, without `.eth` |
| `tokenId` | Decimal mutable V2 token ID from the event; **not** the labelhash |
| `registryAddress` | V2 ETHRegistry |
| `owner` | Event recipient, independent of transaction sender |
| `paymentToken` | Lowercase ERC20 contract address |
| `baseCostRaw`, `premiumRaw`, `totalCostRaw` | Decimal integers in payment-token units; total is base + premium |
| `duration` | Registration duration in seconds |
| `expires`, `label` | Expiry and labelhash from the matching ETHRegistry `LabelRegistered` event |
| `blockTimestamp` | Block timestamp, when included by the stream |
| `subregistry`, `resolver`, `referrer` | Original event fields |

V2 deliberately omits `totalCostWei` and `totalCostEth`; the backend calculates ETH-equivalent and USD values using token decimals and prices. If the matching registry event is absent, expiry is derived from block timestamp + duration when available; otherwise the backend must fetch the block. The backend derives a missing labelhash from the raw label. It must preserve the separate mutable token ID.

The companion registry signature is `LabelRegistered(uint256 indexed tokenId,bytes32 indexed labelHash,string label,address owner,uint64 expiry,address indexed sender)`. Matching requires the V2 registry address, registrar sender, transaction hash, token ID, label and owner.

## Full Filter Code

Paste this complete function into the QuickNode registration stream. Keep full receipt logs to obtain the registry companion event. `decodeEVMReceipts` is provided by QuickNode.

```javascript
function main(stream) {
  // Deployed mainnet ABIs: V1's three formats plus ENSv2's ERC20 format.
  const ENS_ABI = [
    { type: 'event', name: 'NameRegistered', anonymous: false, inputs: [
      { indexed: false, name: 'name', type: 'string' },
      { indexed: true, name: 'label', type: 'bytes32' },
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: false, name: 'cost', type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' }
    ]},
    { type: 'event', name: 'NameRegistered', anonymous: false, inputs: [
      { indexed: false, name: 'name', type: 'string' },
      { indexed: true, name: 'label', type: 'bytes32' },
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: false, name: 'baseCost', type: 'uint256' },
      { indexed: false, name: 'premium', type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' }
    ]},
    { type: 'event', name: 'NameRegistered', anonymous: false, inputs: [
      { indexed: false, name: 'label', type: 'string' },
      { indexed: true, name: 'labelhash', type: 'bytes32' },
      { indexed: true, name: 'owner', type: 'address' },
      { indexed: false, name: 'baseCost', type: 'uint256' },
      { indexed: false, name: 'premium', type: 'uint256' },
      { indexed: false, name: 'expires', type: 'uint256' },
      { indexed: false, name: 'referrer', type: 'bytes32' }
    ]},
    { type: 'event', name: 'NameRegistered', anonymous: false, inputs: [
      { indexed: true, name: 'tokenId', type: 'uint256' },
      { indexed: false, name: 'label', type: 'string' },
      { indexed: false, name: 'owner', type: 'address' },
      { indexed: false, name: 'subregistry', type: 'address' },
      { indexed: false, name: 'resolver', type: 'address' },
      { indexed: false, name: 'duration', type: 'uint64' },
      { indexed: false, name: 'paymentToken', type: 'address' },
      { indexed: true, name: 'referrer', type: 'bytes32' },
      { indexed: false, name: 'base', type: 'uint256' },
      { indexed: false, name: 'premium', type: 'uint256' }
    ]}
  ];
  // Decode separately so registry events can enrich, but never become paid rows.
  const REGISTRY_ABI = [
    { type: 'event', name: 'LabelRegistered', anonymous: false, inputs: [
      { indexed: true, name: 'tokenId', type: 'uint256' },
      { indexed: true, name: 'labelHash', type: 'bytes32' },
      { indexed: false, name: 'label', type: 'string' },
      { indexed: false, name: 'owner', type: 'address' },
      { indexed: false, name: 'expiry', type: 'uint64' },
      { indexed: true, name: 'sender', type: 'address' }
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

  const MIN_TOTAL_WEI = 40_000_000_000_000_000n; // V1 only: 0.04 ETH per name.
  const registrations = decodeEVMReceipts(receiptCopies(), [ENS_ABI]) || [];
  const registryReceipts = decodeEVMReceipts(receiptCopies(), [REGISTRY_ABI]) || [];
  const registryEvents = new Map();
  for (const receipt of registryReceipts) {
    for (const log of (receipt.decodedLogs || [])) {
      if (lc(log.address) !== V2_REGISTRY || lc(getArg(log, 'sender')) !== V2_REGISTRAR) continue;
      const key = `${lc(receipt.transactionHash)}:${toDec(getArg(log, 'tokenId'))}`;
      const events = registryEvents.get(key) || [];
      events.push(log);
      registryEvents.set(key, events);
    }
  }

  const out = [];
  for (const receipt of registrations) {
    for (const log of (receipt.decodedLogs || [])) {
      const contract = lc(log.address);
      if (!CONTRACT_LABELS.has(contract) || contract === V2_RENEWER_V1) continue;
      const tokenId = getArg(log, 'tokenId');
      const paymentToken = getArg(log, 'paymentToken');
      if (contract === V2_REGISTRAR) {
        if (tokenId === undefined || paymentToken === undefined) continue;
        const name = getArg(log, 'label');
        const owner = getArg(log, 'owner');
        const duration = toDec(getArg(log, 'duration'));
        const key = `${lc(receipt.transactionHash)}:${toDec(tokenId)}`;
        const registryEvent = (registryEvents.get(key) || []).find((event) =>
          getArg(event, 'label') === name && lc(getArg(event, 'owner')) === lc(owner));
        const blockTimestamp = blockTimestamps.get(lc(receipt.transactionHash));
        const expires = registryEvent ? toDec(getArg(registryEvent, 'expiry')) :
          (blockTimestamp !== undefined && duration !== undefined ?
            (BigInt(blockTimestamp) + BigInt(duration)).toString() : undefined);
        const base = BigInt(getArg(log, 'base'));
        const premium = BigInt(getArg(log, 'premium'));
        out.push({
          ...context(receipt, log, contract),
          protocolVersion: 2,
          name,
          label: registryEvent ? getArg(registryEvent, 'labelHash') : undefined,
          tokenId: toDec(tokenId), // Mutable registry token ID, distinct from labelhash.
          registryAddress: V2_REGISTRY,
          owner,
          duration,
          expires,
          subregistry: getArg(log, 'subregistry'),
          resolver: getArg(log, 'resolver'),
          referrer: getArg(log, 'referrer'),
          paymentToken: lc(paymentToken),
          baseCostRaw: base.toString(),
          premiumRaw: premium.toString(),
          totalCostRaw: (base + premium).toString(),
        });
        // ERC20 units cannot be compared with an ETH cutoff. Backend converts and filters.
        continue;
      }
      if (tokenId !== undefined || paymentToken !== undefined) continue;
      const labelHash = getArg(log, 'labelhash');
      const name = labelHash !== undefined ? getArg(log, 'label') : getArg(log, 'name');
      const cost = getArg(log, 'cost');
      const base = getArg(log, 'baseCost');
      const premium = getArg(log, 'premium');
      const totalWei = base !== undefined || premium !== undefined ?
        BigInt(base ?? 0) + BigInt(premium ?? 0) : BigInt(cost ?? 0);
      if (totalWei < MIN_TOTAL_WEI) continue;
      out.push({
        ...context(receipt, log, contract),
        name,
        label: labelHash ?? getArg(log, 'label'),
        owner: getArg(log, 'owner'),
        cost: toDec(cost),
        baseCost: toDec(base),
        premium: toDec(premium),
        expires: toDec(getArg(log, 'expires')),
        referrer: getArg(log, 'referrer'),
        totalCostWei: totalWei.toString(),
        totalCostEth: ethStr(totalWei),
      });
    }
  }
  return out.length ? { nameRegistered: out } : null;
}
```

## Verification

Run `node --test tests/quicknode-filters.test.cjs`. The tests execute this embedded function against ABI-encoded receipts using independently captured deployed V2 event ABIs, including stablecoin payments, legacy formats, thresholds and unrelated logs. Apply the updated filter in the QuickNode dashboard after deploying the backend that accepts the V2 payload.
