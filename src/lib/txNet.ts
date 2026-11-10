/*
 * What our receiving wallet NETTED in one transaction, per token: everything
 * into it minus everything out of it, a transfer from the wallet to itself
 * included (in and out cancel). The rule p2collective-app adopted on
 * 2026-11-10 (lib/payments/classify.ts) after store order ST-2026-0017: a
 * Jupiter swap made FROM the receiving wallet routes through it — SOL out,
 * USDC in and straight back out, USDT in — and only the USDT stays, but
 * summing every inbound transfer had credited the USDC hop on top ($320.51
 * for $160.34). This app verifies every hash itself (the storefront's
 * verdict is advisory), so it carries its own copy of the rule.
 *
 * Pure: no fetching. The Verify buttons, the auto-reconcile pass and the
 * assistant's read tool all reach it through lookupTxPayment
 * (src/lib/verifyPayment.ts).
 */

export type NetTransfer = { token: string; amount: number; to: string; from: string | null };
export type TxGain = { token: string; amount: number };

export type WalletNet = {
  /** tokens the wallet kept (in − out above dust), largest first */
  gains: TxGain[];
  /** the wallet's OWN stablecoins that left in this transaction */
  spent: TxGain[];
  /** stablecoin gains at face value; 0 whenever `spent` is non-empty */
  stableUsd: number;
  /** the receiving wallet is among the transaction's signers */
  selfSigned: boolean;
  /** how many transfers landed on the wallet at all (before netting) */
  inbound: number;
  /** every token's net for the wallet, gains and losses */
  net: Record<string, number>;
};

/** The stablecoins the chain libraries list, counted at face value. */
export const STABLES: ReadonlySet<string> = new Set(['USDC', 'USDT', 'PYUSD']);

/**
 * Below this a native-coin gain is dust (a token-account rent refund is
 * 0.00203928 SOL; a fee rebate), not a payment. The storefront's figures.
 */
const NATIVE_DUST: Record<'ETH' | 'SOL', number> = { SOL: 0.005, ETH: 0.0005 };
/** Below this a stablecoin net is rounding, not money (a hundredth of a cent). */
const STABLE_DUST = 0.0001;

const round9 = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * `native` is the chain's gas token (ETH / SOL) — never counted as dollars.
 * EVM addresses compare case-insensitively, Solana addresses exactly.
 * `signers` is EVERY account that signed (a wallet can sign a swap while
 * another account pays the fee).
 */
export function netForWallet(transfers: NetTransfer[], wallet: string, native: 'ETH' | 'SOL', signers: string[]): WalletNet {
  const norm = (a: string | null | undefined) => (native === 'ETH' ? String(a ?? '').toLowerCase() : String(a ?? ''));
  const target = norm(wallet);
  const raw = new Map<string, number>();
  let inbound = 0;
  for (const t of transfers) {
    if (norm(t.to) === target) { raw.set(t.token, (raw.get(t.token) ?? 0) + t.amount); inbound++; }
    if (norm(t.from) === target) raw.set(t.token, (raw.get(t.token) ?? 0) - t.amount);
  }
  const net: Record<string, number> = {};
  const gains: TxGain[] = [];
  const spent: TxGain[] = [];
  for (const [token, v] of raw) {
    const amount = round9(v);
    net[token] = amount;
    const dust = token === native ? NATIVE_DUST[native] : STABLE_DUST;
    if (amount > dust) gains.push({ token, amount });
    if (STABLES.has(token) && amount < -STABLE_DUST) spent.push({ token, amount: -amount });
  }
  gains.sort((a, b) => b.amount - a.amount || a.token.localeCompare(b.token));
  // The wallet's own stablecoins leaving make it no buyer's payment: whatever
  // it netted is a conversion of our money, so it counts $0 (the storefront's
  // rule, Codex 2026-11-10) and a person decides.
  const stableUsd = spent.length ? 0 : round9(gains.filter(g => STABLES.has(g.token)).reduce((s, g) => s + g.amount, 0));
  const selfSigned = signers.some(a => norm(a) === target);
  return { gains, spent, stableUsd, selfSigned, inbound, net };
}
