/**
 * Client-side Helius integration for the Solana rail.
 *
 * - Payment verification: the Enhanced Transactions API returns parsed
 *   token transfers per signature, so a USDC payment's exact amount and
 *   recipient come back without manual pre/post balance math; the RPC's
 *   getTransaction supplies the full signer list.
 * - Wallet snapshots: standard JSON-RPC via the Helius mainnet endpoint.
 */

import { fetchWithBackoff } from './http';

const MINTS: Record<string, { symbol: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
  // PayPal USD — a Token-2022 mint; Helius enhanced transfers and the
  // mint-filtered token-account RPC both handle Token-2022 transparently.
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', decimals: 6 },
};

const rpcUrl = (key: string) => `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`;
const apiUrl = (key: string) => `https://api.helius.xyz/v0/transactions?api-key=${encodeURIComponent(key)}`;

export type SolTransfer = {
  token: string;       // 'USDC' | 'USDT' | 'PYUSD' | 'SOL'
  amount: number;      // whole units
  to: string;          // recipient owner address
  from: string | null;
  at: string | null;
};

/** One signature, parsed: listed token and SOL transfers in BOTH directions, and every account that signed. */
export type SolTx = { transfers: SolTransfer[]; signers: string[] };

/**
 * The parsed transaction. Transfers come back in both directions — the
 * caller nets what its wallet kept (src/lib/txNet.ts), because a swap
 * routes tokens through the wallet and out again — and `signers` lists
 * every account that signed, so a swap the receiving wallet made itself is
 * recognisable even when another account paid the fee.
 */
export async function getSolTx(heliusKey: string, signature: string): Promise<SolTx> {
  let res: Response;
  try {
    res = await fetchWithBackoff(apiUrl(heliusKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] }),
    });
  } catch {
    throw new Error('Could not reach Helius — check your network connection.');
  }
  if (!res.ok) {
    if (res.status === 429) throw new Error('Helius is rate-limiting (429) — wait a few seconds and retry.');
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error || `Helius request failed (HTTP ${res.status}).`);
  }
  const arr = await res.json() as Array<{
    signature?: string;
    timestamp?: number;
    transactionError?: unknown;
    tokenTransfers?: { fromUserAccount?: string; toUserAccount?: string; mint?: string; tokenAmount?: number }[];
    nativeTransfers?: { fromUserAccount?: string; toUserAccount?: string; amount?: number }[];
  }>;
  const tx = Array.isArray(arr) ? arr[0] : undefined;
  // Helius indexes moments behind the chain, so a signature already visible
  // on the explorer can briefly come back empty — say so
  if (!tx) throw new Error('Transaction not indexed yet — if Solscan already shows it, wait a minute and click Verify again (the signature stays saved). If it is not on Solscan either, check the signature and the network.');
  if (tx.transactionError) throw new Error('Transaction failed on-chain.');
  const at = tx.timestamp ? new Date(tx.timestamp * 1000).toISOString() : null;

  const transfers: SolTransfer[] = [];
  for (const t of tx.tokenTransfers || []) {
    const meta = MINTS[String(t.mint || '')];
    if (!meta) continue; // an unrelated SPL token must never read as a stablecoin payment
    const amount = Number(t.tokenAmount || 0);
    if (amount > 0) {
      transfers.push({ token: meta.symbol, amount, to: String(t.toUserAccount || ''), from: t.fromUserAccount || null, at });
    }
  }
  for (const n of tx.nativeTransfers || []) {
    const amount = Number(n.amount || 0) / 1e9; // lamports → SOL
    if (amount > 0.000005) { // ignore rent/fee dust
      transfers.push({ token: 'SOL', amount, to: String(n.toUserAccount || ''), from: n.fromUserAccount || null, at });
    }
  }
  // Every account that signed, not just the fee payer (the enhanced API
  // lists neither in full), from the RPC. An answer we cannot read is a
  // retry, never "nobody signed".
  const parsed = await getParsedTransaction(heliusKey, signature) as
    { transaction?: { message?: { accountKeys?: { pubkey?: string; signer?: boolean }[] } } } | null;
  if (!parsed) throw new Error('Transaction not indexed yet — Helius has not answered for its signers. Wait a minute and click Verify again (the signature stays saved).');
  // Fail closed: every entry must name its account and say whether it
  // signed, and a transaction has at least one signer — a degraded answer
  // must never read as "our wallet did not sign" (Codex, 2026-11-10)
  const keys = parsed.transaction?.message?.accountKeys;
  const unreadable = new Error('Could not read the transaction\'s signers from Helius — click Verify again.');
  if (!Array.isArray(keys) || keys.length === 0) throw unreadable;
  const signers: string[] = [];
  for (const k of keys) {
    if (!k || typeof k !== 'object' || typeof k.pubkey !== 'string' || !k.pubkey || typeof k.signer !== 'boolean') throw unreadable;
    if (k.signer) signers.push(k.pubkey);
  }
  if (signers.length === 0) throw unreadable;
  return { transfers, signers };
}

/**
 * getTransaction, jsonParsed. Jupiter swaps are version-1 transactions
 * (ST-2026-0017's was), and the RPC refuses any version above the one the
 * request allows — naming the one it needs — so allow 1 and, when a newer
 * version is named, ask once more with it.
 */
async function getParsedTransaction(heliusKey: string, signature: string): Promise<unknown> {
  const ask = (version: number) => rpc(heliusKey, 'getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: version, commitment: 'confirmed' }]);
  try {
    return await ask(1);
  } catch (e) {
    const named = /Transaction version \((\d+)\) is not supported/i.exec(e instanceof Error ? e.message : '');
    const version = named ? Number(named[1]) : NaN;
    if (Number.isSafeInteger(version) && version > 1 && version < 100) return ask(version);
    throw e;
  }
}

async function rpc(heliusKey: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetchWithBackoff(rpcUrl(heliusKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (res.status === 429) throw new Error('Helius is rate-limiting (429) — wait a few seconds and retry.');
  if (!res.ok) throw new Error(`Helius RPC HTTP ${res.status}`);
  const j = await res.json() as { result?: unknown; error?: { message?: string } };
  if (j.error) {
    const msg = j.error.message || 'Helius RPC error';
    // Helius signals throttling via HTTP 429 (handled above with backoff);
    // normalize the message just in case a quota error ever arrives as a
    // JSON-RPC error body instead
    if (/rate.?limit|too many requests/i.test(msg)) {
      throw new Error('Helius is rate-limiting — wait a few seconds and retry.');
    }
    throw new Error(msg);
  }
  return j.result;
}

export type SolBalances = { usdc: number; usdt: number; pyusd: number; sol: number };

/** Current SOL + stablecoin balances of a wallet. */
export async function getSolBalances(heliusKey: string, owner: string): Promise<SolBalances> {
  const lamports = await rpc(heliusKey, 'getBalance', [owner]) as { value?: number };
  const out: SolBalances = { usdc: 0, usdt: 0, pyusd: 0, sol: Number(lamports?.value || 0) / 1e9 };
  for (const mint of Object.keys(MINTS)) {
    const accs = await rpc(heliusKey, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]) as {
      value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number | null } } } } } }[];
    };
    const total = (accs?.value || []).reduce(
      (sum, a) => sum + (a.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0), 0);
    const sym = MINTS[mint].symbol;
    if (sym === 'USDC') out.usdc = total;
    if (sym === 'USDT') out.usdt = total;
    if (sym === 'PYUSD') out.pyusd = total;
  }
  return out;
}
