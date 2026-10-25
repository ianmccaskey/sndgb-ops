/**
 * The crypto networks this app reconciles on, and what a transaction hash's
 * SHAPE says about where it can live. Shared by the assistant, the
 * auto-reconcile pass and the order sheet so the rule exists once:
 *  - 0x + 64 hex characters is an EVM hash — Ethereum or Base, the shape
 *    cannot tell which;
 *  - a base58 signature of 64–90 characters is Solana, and only Solana.
 */
export const CRYPTO_METHODS = ['eth', 'sol', 'base'] as const;
export type CryptoMethod = typeof CRYPTO_METHODS[number];

const EVM_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SOL_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Does a bare hash have the shape of a transaction on that network? */
export function hashFitsNetwork(method: string, hash: string): boolean {
  if (method === 'eth' || method === 'base') return EVM_HASH_RE.test(hash);
  if (method === 'sol') return SOL_SIG_RE.test(hash);
  return false;
}

/** Every network a hash of this shape could be on. */
export function networksForHash(hash: string): CryptoMethod[] {
  return CRYPTO_METHODS.filter(m => hashFitsNetwork(m, hash));
}

/** Hashes in operator-facing copy: first 10 and last 6 characters. */
export function shortHash(h: string): string {
  return h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

/**
 * The ordering app's payment_method strings per network — the exact values
 * observed across every imported order. BASE has no upstream value, so a
 * Base rail can never be pushed there (updateOrderRail refuses it too).
 */
export const UPSTREAM_METHOD: Record<string, string> = { sol: 'usdc_sol', eth: 'paige-usdc-eth' };
