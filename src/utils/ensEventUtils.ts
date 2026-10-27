import { formatEther, formatUnits, id, parseUnits } from 'ethers';
import { ENS_V2_REGISTRAR, ENS_V2_REGISTRY, isENSV2PaymentContract } from '../config/ensContracts';
import { CURRENCY_DECIMALS, CURRENCY_MAP, ENS_BASE_REGISTRAR } from './currencyConstants';

/** V2 costs are ERC20 base units; only legacy payloads contain ETH wei. */
export interface ENSPaymentEvent {
  contract: string;
  protocolVersion?: number;
  paymentToken?: string;
  totalCostRaw?: string;
  totalCostWei?: string;
  totalCostEth?: string;
  cost?: string;
}

export interface ENSPayment {
  costWei: string;
  costEth: string;
  costUsd?: string;
  paymentToken?: string;
  paymentAmountRaw?: string;
  paymentAmount?: string;
  paymentSymbol?: string;
}

export async function normalizeENSPayment(
  event: ENSPaymentEvent,
  getETHPriceUSD: (allowFallback?: boolean) => Promise<number | null>
): Promise<ENSPayment> {
  const v2 = isENSV2PaymentContract(event.contract) || event.protocolVersion === 2;
  const token = event.paymentToken?.toLowerCase();
  const symbol = v2 ? (token && CURRENCY_MAP[token]) : 'ETH';
  if (!symbol || (v2 && event.totalCostRaw == null)) {
    throw new Error(`Unsupported or missing ENS payment token/amount: ${token}`);
  }
  const raw = v2 ? event.totalCostRaw : (event.totalCostWei ?? event.cost);
  if (raw == null) throw new Error('Missing ENS payment amount');
  const amount = BigInt(raw);
  if (amount < 0n) throw new Error('Negative ENS payment amount');
  const decimals = CURRENCY_DECIMALS[symbol];
  const paymentAmount = formatUnits(amount, decimals);
  // Match the existing stablecoin valuation used for sales: USDC/USDT/DAI = $1.
  // Never use AlchemyService's emergency $2000 ETH fallback for this conversion.
  const ethPrice = await getETHPriceUSD(symbol === 'ETH').catch(() => null);
  const validPrice = ethPrice != null && Number.isFinite(ethPrice) && ethPrice > 0;
  let wei = amount;
  let costUsd: string | undefined;
  if (symbol === 'ETH') {
    costUsd = validPrice ? (Number(paymentAmount) * ethPrice).toFixed(2) : undefined;
  } else {
    if (!validPrice) throw new Error('ETH/USD price unavailable for ENS token payment conversion');
    const scaledPrice = parseUnits(ethPrice.toFixed(8), 8);
    if (scaledPrice <= 0n) throw new Error('Invalid ETH/USD price');
    wei = amount * 10n ** 26n / (10n ** BigInt(decimals) * scaledPrice);
    costUsd = Number(paymentAmount).toFixed(2);
  }
  return {
    costWei: wei.toString(),
    costEth: formatEther(wei),
    costUsd,
    ...(v2 ? {
      paymentToken: token,
      paymentAmountRaw: amount.toString(),
      paymentAmount,
      paymentSymbol: symbol,
    } : {}),
  };
}

export function getENSAsset(event: { contract: string; name: string; label?: string; tokenId?: string }) {
  const labelHash = event.label || id(event.name);
  if (event.contract.toLowerCase() === ENS_V2_REGISTRAR) {
    if (event.tokenId == null) throw new Error('Missing ENSv2 registry token ID');
    return { contract: ENS_V2_REGISTRY, tokenId: BigInt(event.tokenId).toString(), labelHash };
  }
  // ETHRenewerV1 emits a V2 reservation ID, but the NFT still lives in ENSv1.
  return { contract: ENS_BASE_REGISTRAR, tokenId: BigInt(labelHash).toString(), labelHash };
}

export function parseEventInteger(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid event integer: ${value}`);
  return parsed;
}

export function eventTimestamp(value?: string | number): string | undefined {
  if (value == null) return undefined;
  return new Date(parseEventInteger(value) * 1000).toISOString();
}
