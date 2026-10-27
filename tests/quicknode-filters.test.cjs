const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { Interface, id, ZeroAddress, ZeroHash } = require('ethers');

// Extracted independently from official deployed mainnet ABI JSON, commit
// 4f47cbcc11462fb413196e6b5c0f8090247a6c08. Keep the source fixture independent
// of the Markdown filters: signature/indexing errors must fail actual decoding.
const deployed = require('./fixtures/ensv2-deployed-event-abis.json');
const v2 = new Interface(deployed.ETHRegistrar);
const registry = new Interface(deployed.ETHRegistry);
const legacyRegistration = [
  new Interface(['event NameRegistered(string name,bytes32 indexed label,address indexed owner,uint256 cost,uint256 expires)']),
  new Interface(['event NameRegistered(string name,bytes32 indexed label,address indexed owner,uint256 baseCost,uint256 premium,uint256 expires)']),
  new Interface(['event NameRegistered(string label,bytes32 indexed labelhash,address indexed owner,uint256 baseCost,uint256 premium,uint256 expires,bytes32 referrer)']),
];
const legacyRenewal = [
  new Interface(['event NameRenewed(string name,bytes32 indexed label,uint256 cost,uint256 expires)']),
  new Interface(['event NameRenewed(string label,bytes32 indexed labelhash,uint256 cost,uint256 expires,bytes32 referrer)']),
];
const controllers = [
  '0x283af0b28c62c092c9727f1ee09c02ca627eb7f5',
  '0x253553366da8546fc250f225fe3d25d0c782303b',
  '0x59e16fccd424cc24e280be16e11bcd56fb0ce547',
];
const registrar = '0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81';
const renewer = '0x56c447f308f463a01121c41e72b0e7e7557fcb68';
const ethRegistry = '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2';
const baseRegistrar = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const dai = '0x6b175474e89094c44da98b954eedeac495271d0f';
const owner = '0x1111111111111111111111111111111111111111';
const sender = '0x2222222222222222222222222222222222222222';
const unknown = '0x3333333333333333333333333333333333333333';
const expiry = 1900000000n;
const duration = 31536000n;
const tokenId = (BigInt(id('alice')) & ~0xffffffffn) | 7n;

function event(iface, name, address, values, logIndex = 0) {
  return { address, logIndex, ...iface.encodeEventLog(iface.getEvent(name), values) };
}
function receipt(logs, tx = 'a') {
  return { transactionHash: `0x${tx.repeat(64)}`, blockNumber: '0x100', from: sender, logs };
}
function registration({ name = 'alice', paymentToken = usdc, base = 160000000n, premium = 0n, index = 1 } = {}) {
  return event(v2, 'NameRegistered', registrar,
    [tokenId, name, owner, ZeroAddress, ZeroAddress, duration, paymentToken, ZeroHash, base, premium], index);
}
function labelRegistered({ address = ethRegistry, label = 'alice', registrant = owner, caller = registrar, expires = expiry } = {}) {
  return event(registry, 'LabelRegistered', address,
    [tokenId, id(label), label, registrant, expires, caller], 0);
}
function renewal({ address = registrar, name = 'alice', amount = 8000000n, paymentToken = usdc, index = 0, expires = expiry } = {}) {
  return event(v2, 'NameRenewed', address,
    [tokenId, name, duration, expires, paymentToken, ZeroHash, amount], index);
}
function v1Renewal(name, cost, index = 0, controller = 1, expires = expiry) {
  const values = [name, id(name), cost, expires];
  if (controller === 2) values.push(ZeroHash);
  return event(legacyRenewal[controller === 2 ? 1 : 0], 'NameRenewed', controllers[controller], values, index);
}
function execute(kind, receipts, { shape = 'flat', timestamp, rawStream } = {}) {
  const markdown = fs.readFileSync(path.join(__dirname, '..', 'docs', `quicknode-${kind}-filter.md`), 'utf8');
  const code = [...markdown.matchAll(/```javascript\n([\s\S]*?)\n```/g)]
    .map((match) => match[1]).find((source) => source.startsWith('function main(stream)'));
  assert.ok(code, 'Document must contain the pasteable filter function');
  function decodeEVMReceipts(input, abiGroups) {
    const abi = abiGroups.flat();
    const signatures = abi.map((item) => `${item.name}(${item.inputs.map((arg) => arg.type).join(',')})`);
    assert.equal(signatures.length, new Set(signatures).size, 'QuickNode rejects duplicate ABI signatures');
    const iface = new Interface(abi);
    return input.map((item) => {
      const decodedLogs = [];
      for (const log of item.logs) {
        const parsed = iface.parseLog(log);
        if (!parsed) continue;
        const values = Object.fromEntries(parsed.fragment.inputs.map((arg, index) => [arg.name, parsed.args[index]]));
        const context = { address: log.address, logIndex: log.logIndex };
        if (shape === 'args') decodedLogs.push({ ...context, name: parsed.name, args: values });
        else if (shape === 'params') decodedLogs.push({ ...context, name: parsed.name, params: Object.entries(values).map(([name, value]) => ({ name, value })) });
        else decodedLogs.push({ ...context, ...values });
      }
      // Match a decoder that attaches data to its input receipt.
      item.decodedLogs = decodedLogs;
      return item;
    });
  }
  const context = vm.createContext({ decodeEVMReceipts });
  vm.runInContext(code, context);
  const stream = rawStream ?? { data: [{ block: timestamp === undefined ? {} : { timestamp }, receipts }] };
  const result = context.main(stream);
  return result === null ? null : JSON.parse(JSON.stringify(result));
}

test('V1 registrations preserve all three deployed formats and the inclusive 0.04 ETH threshold', () => {
  for (let version = 0; version < 3; version++) {
    const values = ['alice', id('alice'), owner, 40000000000000000n];
    if (version > 0) values.push(0n);
    values.push(expiry);
    if (version === 2) values.push(ZeroHash);
    const log = event(legacyRegistration[version], 'NameRegistered', controllers[version], values);
    const row = execute('registration', [receipt([log])]).nameRegistered[0];
    assert.equal(row.name, 'alice');
    assert.equal(row.label, id('alice'));
    assert.equal(row.totalCostWei, '40000000000000000');
    assert.equal(row.totalCostEth, '0.04');
    assert.equal(row.owner, owner);
    values[3] -= 1n;
    const cheap = event(legacyRegistration[version], 'NameRegistered', controllers[version], values);
    assert.equal(execute('registration', [receipt([cheap])]), null);
  }
});

test('V2 registration decodes deployed ERC20 ABI, preserves owner/token identity and matches registry expiry', () => {
  const result = execute('registration', [receipt([labelRegistered(), registration({ premium: 500000n })])]);
  assert.equal(result.nameRegistered.length, 1);
  const row = result.nameRegistered[0];
  assert.equal(row.protocolVersion, 2);
  assert.equal(row.owner, owner);
  assert.equal(row.from, sender);
  assert.equal(row.name, 'alice');
  assert.equal(row.label, id('alice'));
  assert.equal(row.tokenId, tokenId.toString());
  assert.notEqual(row.tokenId, BigInt(row.label).toString());
  assert.equal(row.registryAddress, ethRegistry);
  assert.equal(row.expires, expiry.toString());
  assert.equal(row.paymentToken, usdc);
  assert.equal(row.baseCostRaw, '160000000');
  assert.equal(row.premiumRaw, '500000');
  assert.equal(row.totalCostRaw, '160500000');
  assert.equal(row.totalCostWei, undefined);
  assert.equal(row.totalCostEth, undefined);
  assert.equal(row.logIndex, 1);
});

test('DAI registration preserves 18-decimal native amount and never calls it ETH', () => {
  const row = execute('registration', [receipt([registration({ paymentToken: dai, base: 8000000000000000000n })])]).nameRegistered[0];
  assert.equal(row.paymentToken, dai);
  assert.equal(row.totalCostRaw, '8000000000000000000');
  assert.equal(row.totalCostEth, undefined);
});

test('registry-only migrations and unrelated registrar events never become registrations', () => {
  assert.equal(execute('registration', [receipt([labelRegistered(), renewal()])]), null);
  assert.equal(execute('registration', [receipt([{ ...registration(), address: unknown }])]), null);
});

test('registration companion must match registry, sender, owner, label and transaction', () => {
  const logs = [
    labelRegistered({ address: unknown }),
    labelRegistered({ caller: unknown }),
    labelRegistered({ registrant: unknown }),
    labelRegistered({ label: 'bob' }),
    registration(),
  ];
  const row = execute('registration', [receipt(logs), receipt([labelRegistered()], 'b')]).nameRegistered[0];
  assert.equal(row.label, undefined);
  assert.equal(row.expires, undefined);
});

test('registration expiry falls back to containing block timestamp, never wall clock', () => {
  const row = execute('registration', [receipt([registration()])], { timestamp: '0x6a000000' }).nameRegistered[0];
  assert.equal(row.blockTimestamp, BigInt('0x6a000000').toString());
  assert.equal(row.expires, (BigInt('0x6a000000') + duration).toString());
  const missing = execute('registration', [receipt([registration()])]).nameRegistered[0];
  assert.equal(missing.expires, undefined);
});

test('V1 renewals keep each bulk row when the transaction total reaches 0.1 ETH', () => {
  const rows = execute('renewal', [receipt([
    v1Renewal('alice', 40000000000000000n, 0, 0),
    v1Renewal('bob', 30000000000000000n, 1, 1),
    v1Renewal('charlie', 30000000000000000n, 2, 2),
  ])]).nameRenewed;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.name), ['alice', 'bob', 'charlie']);
  assert.equal(rows[0].totalCostEth, '0.04');
  assert.equal(execute('renewal', [receipt([v1Renewal('alice', 99999999999999999n)])]), null);
});

test('renewal threshold is per transaction and excludes logs from unrelated addresses', () => {
  assert.equal(execute('renewal', [
    receipt([v1Renewal('alice', 60000000000000000n)]),
    receipt([v1Renewal('bob', 60000000000000000n)], 'b'),
  ]), null);
  assert.equal(execute('renewal', [receipt([
    v1Renewal('alice', 10000000000000000n),
    { ...v1Renewal('bob', 1000000000000000000n, 1), address: unknown },
  ])]), null);
});

test('both V2 renewal emitters decode exact deployed ABI and preserve raw amounts', () => {
  for (const address of [registrar, renewer]) {
    const row = execute('renewal', [receipt([renewal({ address })])]).nameRenewed[0];
    assert.equal(row.name, 'alice');
    assert.equal(row.tokenId, tokenId.toString());
    assert.equal(row.paymentToken, usdc);
    assert.equal(row.totalCostRaw, '8000000');
    assert.equal(row.totalCostWei, undefined);
    assert.equal(row.totalCostEth, undefined);
    assert.equal(row.registryAddress, address === registrar ? ethRegistry : baseRegistrar);
    assert.equal(row.expires, address === registrar ? expiry.toString() : undefined);
    assert.equal(row.reservationExpires, address === renewer ? expiry.toString() : undefined);
  }
});

test('mixed V1/V2 renewal transactions bypass ETH-only cutoff and preserve individual payment units', () => {
  const rows = execute('renewal', [receipt([
    renewal({ amount: 160000000n }),
    renewal({ name: 'bob', paymentToken: dai, amount: 8000000000000000000n, index: 1 }),
    v1Renewal('charlie', 1000000000000n, 2),
  ])]).nameRenewed;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.totalCostRaw), ['160000000', '8000000000000000000', undefined]);
  assert.equal(rows[2].totalCostWei, '1000000000000');
});

test('ETHRenewerV1 wrapper sync supplies true V1 expiry and is removed without dropping independent renewals', () => {
  const actualExpiry = expiry - 5356801n;
  const rows = execute('renewal', [receipt([
    renewal({ address: renewer }),
    v1Renewal('alice', 0n, 1, 1, actualExpiry),
    v1Renewal('alice', 1000000000000n, 2),
    v1Renewal('bob', 0n, 3),
  ])]).nameRenewed;
  assert.equal(rows.length, 3);
  assert.equal(rows[0].expires, actualExpiry.toString());
  assert.equal(rows[0].reservationExpires, expiry.toString());
  assert.equal(rows[0].label, id('alice'));
  assert.equal(rows[1].cost, '1000000000000');
  assert.equal(rows[2].name, 'bob');
});

test('ETHRegistrar renewal does not suppress unrelated V1 zero-cost events', () => {
  const rows = execute('renewal', [receipt([renewal(), v1Renewal('alice', 0n, 1)])]).nameRenewed;
  assert.equal(rows.length, 2);
});

test('repeated-label renewals pair wrapper expiry in order for single and batch calls', () => {
  const firstExpiry = expiry - 5356801n;
  const secondExpiry = firstExpiry + duration;
  const singleRows = execute('renewal', [receipt([
    renewal({ address: renewer, index: 0 }),
    v1Renewal('alice', 0n, 1, 1, firstExpiry),
    renewal({ address: renewer, index: 2, expires: expiry + duration }),
    v1Renewal('alice', 0n, 3, 1, secondExpiry),
  ])]).nameRenewed;
  assert.deepEqual(singleRows.map((row) => row.expires), [firstExpiry.toString(), secondExpiry.toString()]);
  const batchRows = execute('renewal', [receipt([
    renewal({ address: renewer, index: 0 }),
    renewal({ address: renewer, index: 1, expires: expiry + duration }),
    v1Renewal('alice', 0n, 2, 1, secondExpiry),
    v1Renewal('alice', 0n, 3, 1, secondExpiry),
  ])]).nameRenewed;
  assert.deepEqual(batchRows.map((row) => row.expires), [secondExpiry.toString(), secondExpiry.toString()]);
});

test('unrelated registration/base-registrar events cannot become renewal rows', () => {
  const base = new Interface(['event NameRenewed(uint256 indexed id,uint256 expires)']);
  assert.equal(execute('renewal', [receipt([
    registration(),
    event(base, 'NameRenewed', baseRegistrar, [BigInt(id('alice')), expiry]),
    renewal({ address: unknown }),
  ])]), null);
});

test('both filters accept flat, args and params decoder formats', () => {
  for (const shape of ['flat', 'args', 'params']) {
    const row = execute('registration', [receipt([labelRegistered(), registration()])], { shape }).nameRegistered[0];
    assert.equal(row.name, 'alice');
    assert.equal(row.label, id('alice'));
    assert.equal(execute('renewal', [receipt([renewal()])], { shape }).nameRenewed[0].name, 'alice');
    const old = execute('renewal', [receipt([v1Renewal('alice', 100000000000000000n)])], { shape }).nameRenewed[0];
    assert.equal(old.name, 'alice');
  }
});

test('raw labels that look like hashes are not confused with the event labelhash', () => {
  const name = `0x${'f'.repeat(64)}`;
  const row = execute('renewal', [receipt([v1Renewal(name, 100000000000000000n, 0, 2)])]).nameRenewed[0];
  assert.equal(row.name, name);
  assert.equal(row.label, id(name));
});

test('collects nested/direct receipts and deduplicates repeated receipts without inflating thresholds', () => {
  const r = receipt([v1Renewal('alice', 60000000000000000n)]);
  assert.equal(execute('renewal', [], { rawStream: { data: { nested: { receipts: [r, r] } } } }), null);
  assert.equal(execute('registration', [], { rawStream: [receipt([registration()])] }).nameRegistered.length, 1);
  assert.equal(execute('registration', []), null);
  assert.equal(execute('renewal', []), null);
});
