require('ts-node/register/transpile-only');
const assert = require('node:assert/strict');
const { test } = require('node:test');

// Unit tests never read deployment secrets, call APIs, or connect to PostgreSQL.
for (const [modulePath, exports] of [
  ['../src/utils/config.ts', { config: { logLevel: 'error' } }],
  ['../src/utils/logger.ts', { logger: { debug() {}, info() {}, warn() {}, error() {} } }],
  ['../src/services/emojiMappingService.ts', { emojiMappingService: { replaceEmojisWithSvg: async value => value } }],
]) {
  const filename = require.resolve(modulePath);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
const { DatabaseService } = require('../src/services/databaseService');
const { NewTweetFormatter } = require('../src/services/newTweetFormatter');
const { PuppeteerImageService } = require('../src/services/puppeteerImageService');
const { EthIdImageService } = require('../src/services/ethIdImageService');
const { OpenAIService } = require('../src/services/openaiService');

const payment = {
  paymentToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  paymentAmountRaw: '1234567890', paymentAmount: '1234.56789', paymentSymbol: 'USDC',
};
const event = {
  transactionHash: '0x123', contractAddress: '0x456', tokenId: '123',
  ensName: 'example', fullName: 'example.eth', ownerAddress: '0xowner',
  renewerAddress: '0xrenewer', logIndex: 1, costWei: '500000000000000000',
  costEth: '0.5', costUsd: '1234.57', blockNumber: 1,
  blockTimestamp: '2026-10-27T00:00:00.000Z', processedAt: '2026-10-27T00:00:00.000Z',
  posted: false, ...payment,
};
const dbRow = {
  id: 1, transaction_hash: event.transactionHash, log_index: 1,
  cost_wei: event.costWei, cost_eth: event.costEth, cost_usd: event.costUsd,
  block_timestamp: event.blockTimestamp, processed_at: event.processedAt,
  payment_token: payment.paymentToken, payment_amount_raw: payment.paymentAmountRaw,
  payment_amount: payment.paymentAmount, payment_symbol: payment.paymentSymbol,
};
function formatter() {
  const instance = Object.create(NewTweetFormatter.prototype);
  instance.alchemyService = { getETHPriceUSD: async () => { throw Error('stablecoin must not be repriced'); } };
  instance.clubService = { getClubs: async () => ({ clubs: [] }), getFormattedClubString: async () => '' };
  instance.getHistoricalContext = async () => '';
  instance.getAccountData = async () => null;
  instance.getDisplayHandle = (_profile, address) => address;
  instance.getImageDisplayHandle = (_profile, address) => address;
  return instance;
}

test('both registration insert paths preserve the exact original payment', async () => {
  for (const tracked of [false, true]) {
    const db = new DatabaseService();
    let captured;
    db.pool = { query: async (sql, values) => {
      if (sql.includes('INSERT INTO ens_registrations')) { captured = { sql, values }; return { rows: [{ id: 7 }] }; }
      return { rows: [] };
    } };
    assert.equal(await (tracked ? db.insertRegistrationWithSourceTracking(event, 'test') : db.insertRegistration(event)), 7);
    assert.equal(captured.values.length, 20);
    assert.deepEqual(captured.values.slice(-4), Object.values(payment));
    assert.match(captured.sql, /payment_token, payment_amount_raw, payment_amount, payment_symbol/);
  }
});

test('single and batched renewals retain original units and separate every row', async () => {
  const db = new DatabaseService();
  const inserts = [];
  db.pool = { query: async (sql, values) => { inserts.push({ sql, values }); return { rows: [{ id: 8 }] }; } };
  await db.insertRenewal(event);
  await db.insertRenewalsBatch([event, { ...event, logIndex: 2, paymentAmountRaw: '0', paymentAmount: '0' }]);
  assert.equal(inserts[0].values.length, 22);
  assert.deepEqual(inserts[0].values.slice(-4), Object.values(payment));
  assert.equal(inserts[1].values.length, 44);
  assert.deepEqual(inserts[1].values.slice(18, 22), Object.values(payment));
  assert.deepEqual(inserts[1].values.slice(40), [payment.paymentToken, '0', '0', 'USDC']);
  assert.match(inserts[1].sql, /\$44\)/);
});

test('registration and renewal database reads preserve currency fields', () => {
  const db = new DatabaseService();
  for (const row of [db.mapRegistrationRows([dbRow])[0], db.mapRenewalRows([dbRow])[0]]) {
    for (const field of Object.keys(payment)) assert.equal(row[field], payment[field]);
  }
});

test('payment migration is rerunnable and guards every added column', async () => {
  const db = new DatabaseService();
  const queries = [];
  db.pool = { query: async sql => { queries.push(sql); return { rows: [] }; } };
  await db.runMigrations();
  const migration = queries.find(sql => sql.includes('ALTER TABLE ens_registrations'));
  assert.equal((migration.match(/ADD COLUMN IF NOT EXISTS/g) || []).length, 8);
  assert.match(migration, /ALTER TABLE ens_renewals/);
});

test('stablecoin registration tweet and image show native currency without ETH repricing', async () => {
  const instance = formatter();
  const text = await instance.formatRegistrationTweetText(event, null, event.ownerAddress);
  assert.match(text, /For: \$1,234\.57 \(1,234\.56789 USDC\)/);
  assert.doesNotMatch(text, /0\.50 ETH/);
  assert.equal(instance.validateRegistrationTweet(text).valid, true);
  const image = await instance.convertRegistrationToImageData(event, null, event.ownerAddress);
  assert.equal(image.priceEth, 1234.56789);
  assert.equal(image.currencySymbol, 'USDC');
  assert.equal(image.priceUsd, 1234.57);
});

test('renewal currency totals distinguish homogeneous, mixed, and legacy ETH payments', async () => {
  const instance = formatter();
  const stableText = await instance.formatRenewalTweetText([event, event], null, event.renewerAddress, 1, 2469.14);
  assert.match(stableText, /2,469\.13578 USDC/);
  const legacy = { ...event, paymentSymbol: undefined, paymentAmount: undefined };
  const mixedText = await instance.formatRenewalTweetText([event, legacy], null, event.renewerAddress, 1, 2469.14);
  assert.match(mixedText, /~1\.00 ETH equivalent/);
  const legacyText = await instance.formatRenewalTweetText([legacy], null, event.renewerAddress, 0.5, 1234.57);
  assert.match(legacyText, /\(0\.50 ETH\)/);
  const image = await instance.convertRenewalToImageData([event], null, event.renewerAddress, 0.5, 1234.57);
  assert.equal(image.costIsEthEquivalent, true);
});

test('registration image adapter forwards the actual currency to its template', async t => {
  const original = PuppeteerImageService.generateImageWithBackground;
  t.after(() => { PuppeteerImageService.generateImageWithBackground = original; });
  let imageData;
  PuppeteerImageService.generateImageWithBackground = async data => { imageData = data; return Buffer.alloc(0); };
  await PuppeteerImageService.generateRegistrationImage({ priceEth: 1000, priceUsd: 1000, currencySymbol: 'DAI', ensName: 'example.eth' });
  assert.equal(imageData.currencySymbol, 'DAI');
  assert.equal(imageData.priceEth, 1000);
});

test('renewal template labels non-ETH totals as approximate equivalents', async t => {
  const originals = [PuppeteerImageService.getRenewalTemplatePath, PuppeteerImageService.loadAsBase64, EthIdImageService.fetchNftCard];
  t.after(() => {
    [PuppeteerImageService.getRenewalTemplatePath, PuppeteerImageService.loadAsBase64, EthIdImageService.fetchNftCard] = originals;
  });
  PuppeteerImageService.getRenewalTemplatePath = async () => '';
  PuppeteerImageService.loadAsBase64 = () => '';
  EthIdImageService.fetchNftCard = async () => null;
  const html = await PuppeteerImageService.generateRenewalHTML({
    totalCostEth: 0.5, totalCostUsd: 1234.57, costIsEthEquivalent: true,
    renewerEns: 'example.eth', topNames: [{ ensName: 'example.eth', costEth: 0.5 }], extraCount: 0,
  });
  assert.match(html, /~0\.50 ETH <span class="equivalent-label">equivalent<\/span>/);
});

test('AI prompt keeps stablecoin payment distinct from its ETH valuation', () => {
  const service = Object.create(OpenAIService.prototype);
  const context = {
    event: { type: 'registration', tokenName: 'example.eth', price: 0.5, priceUsd: 1234.57,
      paymentAmount: payment.paymentAmount, paymentSymbol: 'USDC', buyerAddress: '0xowner', timestamp: 1 },
    previousReplies: { recent: [], buyer: [], seller: [] },
    tokenInsights: {}, buyerStats: {}, sellerStats: null, recipientStats: null,
    buyerActivityHistory: [], sellerActivityHistory: [], recipientActivityHistory: [],
    metadata: { tokenDataUnavailable: true, buyerDataUnavailable: true, sellerDataUnavailable: true },
  };
  const prompt = service.buildUserPrompt(context);
  assert.match(prompt, /1234\.56789 USDC \(approximately 0\.5 ETH equivalent\)/);
  assert.match(prompt, /not ETH paid/);
});
