// Ethereum mainnet deployments: https://docs.ens.domains/learn/deployments/
export const ENS_V2_REGISTRAR = '0xd6d8369e55c94ae8afa714e6cf7ab5be54d5cc81';
export const ENS_V2_REGISTRY = '0xf60aba43e1f7f3dab1186ff03b561401c9df85e2';
export const ENS_V2_RENEWER_V1 = '0x56c447f308f463a01121c41e72b0e7e7557fcb68';

export function isENSV2PaymentContract(contract: string): boolean {
  const address = contract.toLowerCase();
  return address === ENS_V2_REGISTRAR || address === ENS_V2_RENEWER_V1;
}
