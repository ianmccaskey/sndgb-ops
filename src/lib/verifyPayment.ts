/**
 * On-chain lookup for one tx-hash payment — shared by the Reconciliation
 * page's Verify buttons and the order sheet's inline Verify. Stablecoin
 * transfers to the receiving wallet count at face value; native ETH/SOL is
 * returned with its token amount only (USD value must then be entered via
 * an order override). Throws with an operator-readable message on every
 * failure mode (missing key, tx not found, failed on-chain, no transfer to
 * our wallet) — callers surface it verbatim.
 */

import { getEvmTxTransfers } from '@/lib/moralis';
import { getSolTxTransfers } from '@/lib/helius';

export type TxLookupResult = {
  amountUsd: number;
  nativeAmount: number | null;
  nativeSymbol: string | null;
  note: string;
};

export async function lookupTxPayment(
  method: string,
  txHash: string,
  settings: Record<string, string>,
): Promise<TxLookupResult> {
  if (method === 'sol') {
    const key = settings.helius_api_key;
    if (!key) throw new Error('Set the Helius API key in Settings first.');
    const wallet = (settings.sol_wallet_address || '').trim();
    const transfers = await getSolTxTransfers(key, txHash);
    const toUs = wallet ? transfers.filter(t => t.to === wallet) : transfers;
    // Everything the lib maps except the native coin is a USD stablecoin
    // (USDC/USDT/PYUSD today) — counted at face value.
    const stable = toUs.filter(t => t.token !== 'SOL').reduce((s, t) => s + t.amount, 0);
    const native = toUs.filter(t => t.token === 'SOL').reduce((s, t) => s + t.amount, 0);
    if (stable === 0 && native === 0) throw new Error(wallet ? 'No transfer to the configured SOL wallet found in this tx.' : 'No stablecoin transfer found in this tx.');
    return {
      amountUsd: stable,
      nativeAmount: native > 0 ? native : null,
      nativeSymbol: native > 0 ? 'SOL' : null,
      note: wallet ? '' : 'No SOL wallet configured — amount not recipient-checked.',
    };
  }
  if (method === 'eth' || method === 'base') {
    const key = settings.moralis_api_key;
    if (!key) throw new Error('Set the Moralis API key in Settings first.');
    const walletKey = method === 'base' ? 'base_wallet_address' : 'eth_wallet_address';
    const wallet = (settings[walletKey] || '').trim().toLowerCase();
    const transfers = await getEvmTxTransfers(key, method, txHash);
    const toUs = wallet ? transfers.filter(t => t.to === wallet) : transfers;
    // Everything the lib maps except the native coin is a USD stablecoin
    // (USDC/USDT/PYUSD today) — counted at face value.
    const stable = toUs.filter(t => t.token !== 'ETH').reduce((s, t) => s + t.amount, 0);
    const native = toUs.filter(t => t.token === 'ETH').reduce((s, t) => s + t.amount, 0);
    if (stable === 0 && native === 0) throw new Error(wallet ? 'No transfer to the configured wallet found in this tx.' : 'No stablecoin transfer found in this tx.');
    return {
      amountUsd: stable,
      nativeAmount: native > 0 ? native : null,
      nativeSymbol: native > 0 ? 'ETH' : null,
      note: wallet ? '' : 'No wallet address configured — amount not recipient-checked.',
    };
  }
  throw new Error(`Cannot chain-verify a ${method} payment.`);
}
