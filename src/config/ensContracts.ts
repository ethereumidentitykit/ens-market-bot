// Ethereum mainnet deployments: https://docs.ens.domains/learn/deployments/
export const ENS_V2_REGISTRAR = '0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81';
export const ENS_V2_REGISTRY = '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2';
export const ENS_V2_RENEWER_V1 = '0x56c447f308f463a01121c41e72b0e7e7557fcb68';

export function isENSV2PaymentContract(contract: string): boolean {
  const address = contract.toLowerCase();
  return address === ENS_V2_REGISTRAR || address === ENS_V2_RENEWER_V1;
}

/**
 * Gas-sponsoring relayers whose transactions register names on users' behalf.
 * Their tx.from is the relayer, so it must never be credited as the minter.
 *
 * 0x4656…a28e calls router 0x0000…5ad9ce…adaaf, which executes the user's intent
 * from a per-user smart account. That account pays the USDC, and the user's wallet
 * is the registered owner: over blocks 26.30M–26.45M, 1,676 relayed registrations
 * mapped 1:1 between 1,016 smart accounts and 1,016 owners. The owner is the minter.
 *
 * Adding an address here only affects new rows. Existing rows are corrected by a
 * keyed migration in DatabaseService, so add a new migration key as well.
 */
export const ENS_REGISTRATION_RELAYERS: ReadonlySet<string> = new Set([
  '0x46565eedb0bb948ae787dd105cce300f736da28e',
]);

export function isENSRegistrationRelayer(address?: string | null): boolean {
  return !!address && ENS_REGISTRATION_RELAYERS.has(address.toLowerCase());
}
