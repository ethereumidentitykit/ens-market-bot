const assert = require('node:assert/strict');
const { test } = require('node:test');
const { AbiCoder, id } = require('ethers');
const axios = require('axios');

require('ts-node/register/transpile-only');

// These ingestion tests never read credentials or reach metadata/RPC services.
function mockModule(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
mockModule('../src/utils/logger.ts', {
  logger: { info() {}, debug() {}, warn() {}, error() {} },
});
mockModule('../src/utils/config.ts', {
  config: { alchemy: { baseUrl: 'https://rpc.example.test', apiKey: 'unit-test' } },
});
const subgraph = { async getOwnerByTokenId() { return OWNER; } };
mockModule('../src/services/ensSubgraphService.ts', { ensSubgraphService: subgraph });

const {
  normalizeENSPayment, getENSAsset, parseEventInteger, eventTimestamp,
} = require('../src/utils/ensEventUtils.ts');
const {
  ENS_V2_REGISTRAR, ENS_V2_REGISTRY, ENS_V2_RENEWER_V1,
} = require('../src/config/ensContracts.ts');
const { ENS_BASE_REGISTRAR } = require('../src/utils/currencyConstants.ts');
const { QuickNodeRegistrationService } = require('../src/services/quickNodeRegistrationService.ts');
const { QuickNodeRenewalService } = require('../src/services/quickNodeRenewalService.ts');
const { AlchemyService } = require('../src/services/alchemyService.ts');

const OWNER = '0x1111111111111111111111111111111111111111';
const PAYER = '0x2222222222222222222222222222222222222222';
const LEGACY_CONTROLLER = '0x59e16fccd424cc24e280be16e11bcd56fb0ce547';
const WRAPPED_CONTROLLER = '0x253553366da8546fc250f225fe3d25d0c782303b';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';
const LABEL_HASH = id('alice');
const V2_TOKEN_ID = ((BigInt(LABEL_HASH) >> 32n << 32n) + 7n).toString();
const BLOCK_TIME = 1_720_000_000;
const YEAR = 31_536_000;

function registration(overrides = {}) {
  return {
    blockNumber: '0x1234', contract: LEGACY_CONTROLLER, contractLabel: 'Legacy',
    name: 'alice', owner: OWNER, label: LABEL_HASH, logIndex: '0x6',
    txHash: `0x${'ab'.repeat(32)}`, from: PAYER,
    expires: String(BLOCK_TIME + YEAR), totalCostWei: '1000000000000000000',
    totalCostEth: '999', ...overrides,
  };
}

function v2Registration(overrides = {}) {
  return registration({
    contract: ENS_V2_REGISTRAR, contractLabel: 'ENSv2 ETHRegistrar',
    protocolVersion: 2, tokenId: V2_TOKEN_ID, paymentToken: USDC,
    totalCostRaw: '5000000', totalCostWei: undefined, totalCostEth: undefined,
    duration: String(YEAR), expires: undefined, blockTimestamp: String(BLOCK_TIME),
    ...overrides,
  });
}

function renewal(overrides = {}) {
  const { owner, ...event } = registration();
  return { ...event, ...overrides };
}

function v2Renewal(overrides = {}) {
  const { owner, ...event } = v2Registration();
  return { ...event, expires: String(BLOCK_TIME + YEAR), ...overrides };
}

function harness(t, options = {}) {
  const rows = [];
  const calls = { metadata: [], block: [], owners: [], price: [], legacyOwners: [], legacyExpiries: [] };
  t.mock.method(subgraph, 'getOwnerByTokenId', async (...args) => {
    calls.legacyOwners.push(args);
    return OWNER;
  });
  const db = {
    async insertRegistrationWithSourceTracking(row, source) {
      assert.equal(source, 'quicknode'); rows.push(row); return rows.length;
    },
    async insertRenewalsBatch(batch) {
      rows.push(...batch); return batch.map((_, index) => index + 1);
    },
  };
  const alchemy = {
    async getETHPriceUSD(allowFallback) {
      calls.price.push(allowFallback);
      return Object.hasOwn(options, 'ethPrice') ? options.ethPrice : 2500;
    },
    async getBlockTimestamp(...args) { calls.block.push(args); return BLOCK_TIME; },
    async getENSV2Owner(...args) { calls.owners.push(args); return OWNER; },
    async getENSV1Expiry(...args) { calls.legacyExpiries.push(args); return BLOCK_TIME + YEAR; },
  };
  const opensea = {
    async getSimplifiedMetadata(...args) {
      calls.metadata.push(args);
      return { name: 'alice.eth', image: 'https://example.test/alice.png' };
    },
  };
  const metadata = {
    async getMetadataWithFallback() { return null; },
    async getMetadata() { return null; },
  };
  return {
    rows, calls,
    registrations: new QuickNodeRegistrationService(db, metadata, alchemy, opensea),
    renewals: new QuickNodeRenewalService(db, metadata, alchemy, opensea),
  };
}

test('USDC costs retain raw provenance and convert six decimals to ETH equivalent', async () => {
  const calls = [];
  const payment = await normalizeENSPayment(v2Registration(), async (fallback) => {
    calls.push(fallback); return 2500;
  });
  assert.equal(payment.costWei, '2000000000000000');
  assert.equal(payment.costEth, '0.002');
  assert.equal(payment.costUsd, '5.00');
  assert.equal(payment.paymentAmountRaw, '5000000');
  assert.equal(payment.paymentAmount, '5.0');
  assert.equal(payment.paymentToken, USDC);
  assert.equal(payment.paymentSymbol, 'USDC');
  assert.deepEqual(calls, [false], 'stablecoin conversion must reject emergency ETH prices');
});

test('DAI costs use eighteen decimals and retain amounts beyond Number integer precision', async () => {
  const raw = '5000000000000000001';
  const payment = await normalizeENSPayment(v2Renewal({ paymentToken: DAI, totalCostRaw: raw }), async () => 2500);
  assert.equal(payment.paymentAmountRaw, raw);
  assert.equal(payment.paymentAmount, '5.000000000000000001');
  assert.equal(payment.paymentSymbol, 'DAI');
  assert.equal(payment.costWei, '2000000000000000');
  assert.equal(payment.costUsd, '5.00');
});

test('legacy payments continue using wei even when supplied ETH display text is wrong', async () => {
  const payment = await normalizeENSPayment(registration(), async () => 2500);
  assert.equal(payment.costWei, '1000000000000000000');
  assert.equal(payment.costEth, '1.0');
  assert.equal(payment.costUsd, '2500.00');
  assert.equal(payment.paymentToken, undefined);
  assert.equal(payment.paymentAmountRaw, undefined);
  const withoutPrice = await normalizeENSPayment(registration(), async () => null);
  assert.equal(withoutPrice.costEth, '1.0');
  assert.equal(withoutPrice.costUsd, undefined);
});

test('missing, unavailable, and invalid ETH prices cannot misvalue stablecoin events', async () => {
  for (const value of [null, 0, -1, Infinity, NaN]) {
    await assert.rejects(normalizeENSPayment(v2Registration(), async () => value), /price/i);
  }
  await assert.rejects(normalizeENSPayment(v2Registration(), async () => { throw new Error('offline'); }), /price/i);
});

test('unknown tokens, missing raw amounts, malformed and negative costs fail safely', async () => {
  for (const overrides of [
    { paymentToken: OWNER }, { paymentToken: undefined },
    { totalCostRaw: undefined, totalCostWei: '5000000' },
    { totalCostRaw: '-1' }, { totalCostRaw: 'five' },
  ]) {
    await assert.rejects(normalizeENSPayment(v2Registration(overrides), async () => 2500));
  }
});

test('V2 asset token IDs and legacy renewal reservation IDs stay distinct from labelhashes', () => {
  assert.notEqual(V2_TOKEN_ID, BigInt(LABEL_HASH).toString());
  assert.deepEqual(getENSAsset(v2Registration()), {
    contract: ENS_V2_REGISTRY, tokenId: V2_TOKEN_ID, labelHash: LABEL_HASH,
  });
  assert.deepEqual(getENSAsset(v2Renewal({ contract: ENS_V2_RENEWER_V1 })), {
    contract: ENS_BASE_REGISTRAR, tokenId: BigInt(LABEL_HASH).toString(), labelHash: LABEL_HASH,
  });
  assert.deepEqual(getENSAsset(registration({ label: undefined })), {
    contract: ENS_BASE_REGISTRAR, tokenId: BigInt(LABEL_HASH).toString(), labelHash: LABEL_HASH,
  });
  assert.throws(() => getENSAsset(v2Registration({ tokenId: undefined })), /token ID/i);
});

test('event integer and timestamp normalization accepts hex and decimal and rejects unsafe values', () => {
  assert.equal(parseEventInteger('0x1234'), 4660);
  assert.equal(parseEventInteger('4660'), 4660);
  assert.equal(parseEventInteger(4660), 4660);
  assert.equal(eventTimestamp(String(BLOCK_TIME)), new Date(BLOCK_TIME * 1000).toISOString());
  assert.equal(eventTimestamp(undefined), undefined);
  for (const value of ['nope', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseEventInteger(value));
  }
});

test('legacy registration ingestion preserves owner, payer, price, expiry and legacy NFT identity', async (t) => {
  const h = harness(t);
  await h.registrations.processRegistrations({ nameRegistered: [registration()] });
  assert.equal(h.rows.length, 1);
  const row = h.rows[0];
  assert.equal(row.tokenId, BigInt(LABEL_HASH).toString());
  assert.equal(row.ownerAddress, OWNER);
  assert.equal(row.executorAddress, PAYER);
  assert.equal(Number(row.costEth), 1);
  assert.equal(row.costUsd, '2500.00');
  assert.equal(row.expiresAt, new Date((BLOCK_TIME + YEAR) * 1000).toISOString());
  assert.equal(h.calls.metadata[0][0].toLowerCase(), ENS_BASE_REGISTRAR);
});

test('V2 registration ingests USDC provenance, registry metadata and duration-derived expiry', async (t) => {
  const h = harness(t);
  await h.registrations.processRegistrations({ nameRegistered: [v2Registration()] });
  assert.equal(h.rows.length, 1);
  const row = h.rows[0];
  assert.equal(row.tokenId, V2_TOKEN_ID);
  assert.equal(row.ownerAddress, OWNER);
  assert.equal(row.executorAddress, PAYER);
  assert.equal(row.paymentToken, USDC);
  assert.equal(row.paymentAmountRaw, '5000000');
  assert.equal(row.paymentSymbol, 'USDC');
  assert.equal(Number(row.costEth), 0.002);
  assert.equal(row.costUsd, '5.00');
  assert.equal(row.expiresAt, new Date((BLOCK_TIME + YEAR) * 1000).toISOString());
  assert.equal(row.blockTimestamp, new Date(BLOCK_TIME * 1000).toISOString());
  assert.deepEqual(h.calls.metadata[0], [ENS_V2_REGISTRY, V2_TOKEN_ID]);
});

test('V2 registrations fetch the real block time when timestamp and expiry are absent', async (t) => {
  const h = harness(t);
  await h.registrations.processRegistrations({ nameRegistered: [v2Registration({ blockTimestamp: undefined })] });
  assert.deepEqual(h.calls.block, [[4660]]);
  assert.equal(h.rows[0].expiresAt, new Date((BLOCK_TIME + YEAR) * 1000).toISOString());
});

test('V2 registration with unavailable conversion price never persists a near-zero ETH cost', async (t) => {
  const h = harness(t, { ethPrice: null });
  await assert.rejects(h.registrations.processRegistrations({ nameRegistered: [v2Registration()] }), /price/i);
  assert.equal(h.rows.length, 0);
});

test('V2 renewals use registry owner lookup, duration, and original DAI amount', async (t) => {
  const h = harness(t);
  const result = await h.renewals.processRenewals({
    nameRenewed: [v2Renewal({ paymentToken: DAI, totalCostRaw: '5000000000000000000' })],
  });
  assert.equal(result.rowsInserted, 1);
  const row = h.rows[0];
  assert.equal(row.tokenId, V2_TOKEN_ID);
  assert.equal(row.durationSeconds, YEAR);
  assert.equal(row.ownerAddress, OWNER);
  assert.equal(row.renewerAddress, PAYER);
  assert.equal(row.paymentSymbol, 'DAI');
  assert.equal(row.paymentAmountRaw, '5000000000000000000');
  assert.equal(row.costUsd, '5.00');
  assert.equal(row.expiresAt, new Date((BLOCK_TIME + YEAR) * 1000).toISOString());
  assert.deepEqual(h.calls.owners, [[LABEL_HASH, 4660]]);
  assert.deepEqual(h.calls.legacyOwners, []);
  assert.deepEqual(h.calls.metadata[0], [ENS_V2_REGISTRY, V2_TOKEN_ID]);
});

test('ETHRenewerV1 renewals keep legacy NFT ownership while preserving token payment', async (t) => {
  const h = harness(t);
  const result = await h.renewals.processRenewals({ nameRenewed: [v2Renewal({ contract: ENS_V2_RENEWER_V1 })] });
  assert.equal(result.rowsInserted, 1);
  assert.equal(h.rows[0].tokenId, BigInt(LABEL_HASH).toString());
  assert.equal(h.rows[0].ownerAddress, OWNER);
  assert.equal(h.rows[0].durationSeconds, YEAR);
  assert.equal(h.rows[0].paymentSymbol, 'USDC');
  assert.deepEqual(h.calls.owners, []);
  assert.equal(h.calls.legacyOwners[0][0], BigInt(LABEL_HASH).toString());
  assert.equal(h.calls.metadata[0][0].toLowerCase(), ENS_BASE_REGISTRAR);
});

test('unwrapped ETHRenewerV1 names fetch V1 expiry when no wrapper companion supplies it', async (t) => {
  const h = harness(t);
  const result = await h.renewals.processRenewals({ nameRenewed: [v2Renewal({
    contract: ENS_V2_RENEWER_V1,
    expires: undefined,
    reservationExpiry: String(BLOCK_TIME + YEAR + 5_356_801),
  })] });
  assert.equal(result.rowsInserted, 1);
  assert.deepEqual(h.calls.legacyExpiries, [[LABEL_HASH, 4660]]);
  assert.equal(h.rows[0].expiresAt, new Date((BLOCK_TIME + YEAR) * 1000).toISOString());
});

test('legacy renewals remain compatible with numeric/hex log indexes and historical costs', async (t) => {
  const h = harness(t);
  const result = await h.renewals.processRenewals({ nameRenewed: [renewal({ logIndex: 6 }), renewal({ logIndex: '0x7' })] });
  assert.equal(result.rowsInserted, 2);
  assert.deepEqual(h.rows.map(row => row.logIndex), [6, 7]);
  assert.equal(h.rows[0].tokenId, BigInt(LABEL_HASH).toString());
  assert.equal(Number(h.rows[0].costEth), 1);
  assert.equal(h.rows[0].durationSeconds, undefined);
  assert.equal(h.rows[0].paymentToken, undefined);
});

test('legacy zero-cost wrapper sync is suppressed beside its paid ETHRenewerV1 renewal', async (t) => {
  const h = harness(t);
  const result = await h.renewals.processRenewals({ nameRenewed: [
    v2Renewal({ contract: ENS_V2_RENEWER_V1, logIndex: '0x6' }),
    renewal({ contract: WRAPPED_CONTROLLER, logIndex: '0x7', totalCostWei: '0' }),
    renewal({ contract: LEGACY_CONTROLLER, logIndex: '0x8', totalCostWei: '1000000000000000000' }),
  ] });
  assert.equal(result.rowsInserted, 2);
  assert.deepEqual(h.rows.map(row => row.logIndex).sort(), [6, 8]);
});

test('unpriced V2 renewal aborts its whole transaction without publishing a partial bulk total', async (t) => {
  const h = harness(t, { ethPrice: null });
  const result = await h.renewals.processRenewals({ nameRenewed: [v2Renewal(), renewal({ logIndex: '0x7' })] });
  assert.equal(result.rowsInserted, 0);
  assert.equal(result.errors, 1);
  assert.equal(h.rows.length, 0);
});

test('unpriced V2 renewal does not block unrelated legacy transactions in the same webhook', async (t) => {
  const h = harness(t, { ethPrice: null });
  const result = await h.renewals.processRenewals({ nameRenewed: [
    v2Renewal(), renewal({ logIndex: '0x7', txHash: `0x${'cd'.repeat(32)}` }),
  ] });
  assert.equal(result.rowsInserted, 1);
  assert.equal(result.errors, 1);
  assert.equal(h.rows[0].logIndex, 7);
  assert.equal(Number(h.rows[0].costEth), 1);
});

test('bulk V2 preflight shares one strict quote and processing reuses it after the provider fails', async (t) => {
  const options = { ethPrice: 2500 };
  const h = harness(t, options);
  const payload = {
    nameRenewed: Array.from({ length: 120 }, (_, index) => v2Renewal({
      logIndex: index,
      paymentToken: index % 2 === 0 ? USDC : DAI,
      totalCostRaw: index % 2 === 0 ? '5000000' : '5000000000000000000',
    })),
  };
  const payments = await h.renewals.prepareRenewalPayments(payload);
  assert.deepEqual(h.calls.price, [false], 'one strict quote covers the entire bulk transaction');
  assert.equal(h.rows.length, 0, 'preflight does not write or enrich');
  assert.equal(h.calls.metadata.length, 0);
  assert.equal(h.calls.owners.length, 0);
  options.ethPrice = null;
  const result = await h.renewals.processRenewals(payload, payments);
  assert.equal(result.rowsInserted, 120);
  assert.equal(result.errors, 0);
  assert.deepEqual(h.calls.price, [false], 'background processing must reuse the accepted preflight prices');
  assert.ok(h.rows.every(row => row.costUsd === '5.00' && Number(row.costEth) === 0.002));
});

test('payment preflight rejects unavailable prices before any renewal work is accepted', async (t) => {
  const h = harness(t, { ethPrice: null });
  await assert.rejects(h.renewals.prepareRenewalPayments({ nameRenewed: [v2Renewal()] }), /price/i);
  assert.equal(h.rows.length, 0);
  assert.equal(h.calls.metadata.length, 0);
  assert.equal(h.calls.owners.length, 0);
});

test('V2 owner RPC uses the event block and decodes latestOwner even during grace', async (t) => {
  const abi = AbiCoder.defaultAbiCoder();
  const currentToken = (BigInt(V2_TOKEN_ID) + 4n).toString();
  t.mock.method(axios, 'post', async (url, request) => {
    assert.equal(url, 'https://rpc.example.test/v2/unit-test');
    assert.equal(request.method, 'eth_call');
    assert.equal(request.params[0].to, ENS_V2_REGISTRY);
    assert.equal(request.params[0].data, id('getState(uint256)').slice(0, 10) + abi.encode(['uint256'], [LABEL_HASH]).slice(2));
    assert.equal(request.params[1], '0x1234');
    // The static tuple is status, expiry, latestOwner, current tokenId, resource.
    // status=AVAILABLE, expiry in the past: latestOwner still identifies the holder.
    return { data: { result: abi.encode(
      ['uint8', 'uint64', 'address', 'uint256', 'uint256'],
      [0, BLOCK_TIME - 3600, OWNER, currentToken, V2_TOKEN_ID],
    ) } };
  });
  const service = new AlchemyService({});
  assert.equal(await service.getENSV2Owner(LABEL_HASH, 4660), OWNER);
});

test('V2 owner RPC returns null for reservations and failed contract reads', async (t) => {
  const post = t.mock.method(axios, 'post', async () => ({ data: { result: AbiCoder.defaultAbiCoder().encode(
    ['uint8', 'uint64', 'address', 'uint256', 'uint256'],
    [1, BLOCK_TIME + YEAR, '0x0000000000000000000000000000000000000000', V2_TOKEN_ID, V2_TOKEN_ID],
  ) } }));
  const service = new AlchemyService({});
  assert.equal(await service.getENSV2Owner(LABEL_HASH, 4660), null);
  post.mock.mockImplementation(async () => ({ data: { error: { message: 'missing historical state' } } }));
  assert.equal(await service.getENSV2Owner(LABEL_HASH, 4660), null);
});

test('V1 expiry RPC reads the legacy registrar labelhash at the event block', async (t) => {
  const abi = AbiCoder.defaultAbiCoder();
  t.mock.method(axios, 'post', async (_, request) => {
    assert.equal(request.method, 'eth_call');
    assert.equal(request.params[0].to, ENS_BASE_REGISTRAR);
    assert.equal(request.params[0].data, id('nameExpires(uint256)').slice(0, 10) + abi.encode(['uint256'], [LABEL_HASH]).slice(2));
    assert.equal(request.params[1], '0x1234');
    return { data: { result: abi.encode(['uint256'], [BLOCK_TIME + YEAR]) } };
  });
  const service = new AlchemyService({});
  assert.equal(await service.getENSV1Expiry(LABEL_HASH, 4660), BLOCK_TIME + YEAR);
});

test('strict ETH pricing bypasses an existing emergency price and never creates one', async (t) => {
  const get = t.mock.method(axios, 'get', async () => { throw new Error('price service unavailable'); });
  const service = new AlchemyService({});
  assert.equal(await service.getETHPriceUSD(), 2000, 'legacy callers retain emergency fallback');
  assert.equal(get.mock.callCount(), 1);
  assert.equal(await service.getETHPriceUSD(false), null, 'stablecoin conversions must not use cached fallback');
  assert.equal(get.mock.callCount(), 2, 'strict pricing retries the real API');
  assert.equal(await service.getETHPriceUSD(), 2000, 'legacy cached fallback remains available');
  assert.equal(get.mock.callCount(), 2);
  get.mock.mockImplementation(async () => ({ data: { data: [{
    symbol: 'ETH', prices: [{ currency: 'usd', value: '3123.45', lastUpdatedAt: new Date().toISOString() }],
  }] } }));
  assert.equal(await service.getETHPriceUSD(false), 3123.45);
  assert.equal(await service.getETHPriceUSD(false), 3123.45);
  assert.equal(get.mock.callCount(), 3, 'a real quote can be cached for strict requests');
});
