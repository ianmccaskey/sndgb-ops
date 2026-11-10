/**
 * On-chain lookup for one tx-hash payment — shared by the Reconciliation
 * page's Verify buttons, the order sheet's inline Verify, the
 * auto-reconcile pass (src/lib/autoRecon.ts) and the assistant's read tool.
 *
 * What counts is what our receiving wallet NETTED in the transaction, per
 * token (src/lib/txNet.ts, 2026-11-10): a swap that routes a stablecoin in
 * and straight back out counts nothing for that hop. Stablecoin gains
 * count at face value; a native ETH/SOL gain is returned with its token
 * amount only (USD value must then be entered via an order override).
 *
 * Two shapes are never a buyer's payment and come back with `needsPerson`
 * set, for every caller to leave unrecorded: a transaction our receiving
 * wallet signed itself (a swap or transfer we made), and one in which the
 * wallet's own stablecoins left (a conversion of our money — it counts $0).
 *
 * Throws with an operator-readable message on every failure mode (missing
 * key or wallet, tx not found, failed on-chain, nothing kept by our
 * wallet) — callers surface it verbatim.
 */

import { getEvmTx } from '@/lib/moralis';
import { getSolTx } from '@/lib/helius';
import { netForWallet } from '@/lib/txNet';
import type { NetTransfer, TxGain } from '@/lib/txNet';

export type { TxGain };

export type TxLookupResult = {
  /** stablecoin the wallet netted, at face value; 0 when its own stablecoins left */
  amountUsd: number;
  nativeAmount: number | null;
  nativeSymbol: string | null;
  note: string;
  /** every token the wallet kept (in − out), largest first */
  gains: TxGain[];
  /** the wallet's own stablecoins that left in this transaction */
  spent: TxGain[];
  /** the receiving wallet is among the transaction's signers */
  selfSigned: boolean;
  /**
   * Set when the result must not be recorded without a person's decision:
   * one or two sentences for the operator, saying what the chain shows and
   * what to do. Every caller leaves the payment pending when it is set.
   */
  needsPerson: string | null;
};

const fmt = (n: number) => String(Math.round(n * 1e9) / 1e9);
const listGains = (gs: TxGain[]) => gs.map(g => `${fmt(g.amount)} ${g.token}`).join(' + ');
const NEXT_STEP = 'If it converts this order\'s payment, set an order override for the total received; otherwise reject it (reason required).';

function fromTransfers(transfers: NetTransfer[], wallet: string, native: 'ETH' | 'SOL', signers: string[], network: string): TxLookupResult {
  const n = netForWallet(transfers, wallet, native, signers);
  if (n.gains.length === 0) {
    throw new Error(n.inbound > 0
      ? `No transfer to the configured ${network} wallet stays there — what came into it left again in the same transaction, so it paid nothing.`
      : `No transfer to the configured ${network} wallet found in this tx.`);
  }
  const nativeGain = n.gains.find(g => g.token === native)?.amount ?? 0;
  const needsPerson = n.spent.length
    ? `Our receiving wallet's own stablecoins left in this transaction (${listGains(n.spent)}) — a swap of our money, not a buyer's payment, so it counts $0. ${NEXT_STEP}`
    : n.selfSigned
      ? `Signed by our receiving wallet itself (it kept ${listGains(n.gains)}) — a swap or transfer we made, not a buyer's payment. ${NEXT_STEP}`
      : null;
  return {
    amountUsd: n.stableUsd,
    nativeAmount: nativeGain > 0 ? nativeGain : null,
    nativeSymbol: nativeGain > 0 ? native : null,
    note: '',
    gains: n.gains,
    spent: n.spent,
    selfSigned: n.selfSigned,
    needsPerson,
  };
}

export async function lookupTxPayment(
  method: string,
  txHash: string,
  settings: Record<string, string>,
): Promise<TxLookupResult> {
  if (method === 'sol') {
    const key = settings.helius_api_key;
    if (!key) throw new Error('Set the Helius API key in Settings first.');
    // without our wallet there is nothing to net against: every transfer in
    // a swap would count (the over-count this lookup exists to avoid)
    const wallet = (settings.sol_wallet_address || '').trim();
    if (!wallet) throw new Error('Set the SOL receiving wallet address in Settings first — without it the lookup cannot tell what our wallet kept.');
    const tx = await getSolTx(key, txHash);
    return fromTransfers(tx.transfers, wallet, 'SOL', tx.signers, 'SOL');
  }
  if (method === 'eth' || method === 'base') {
    const key = settings.moralis_api_key;
    if (!key) throw new Error('Set the Moralis API key in Settings first.');
    const walletKey = method === 'base' ? 'base_wallet_address' : 'eth_wallet_address';
    const wallet = (settings[walletKey] || '').trim().toLowerCase();
    if (!wallet) throw new Error(`Set the ${method.toUpperCase()} receiving wallet address in Settings first — without it the lookup cannot tell what our wallet kept.`);
    const tx = await getEvmTx(key, method, txHash);
    return fromTransfers(tx.transfers, wallet, 'ETH', tx.signers, method.toUpperCase());
  }
  throw new Error(`Cannot chain-verify a ${method} payment.`);
}
