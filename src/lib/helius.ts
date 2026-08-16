/**
 * Client-side Helius integration for the Solana rail.
 *
 * - Payment verification: the Enhanced Transactions API returns parsed
 *   token transfers per signature, so a USDC payment's exact amount and
 *   recipient come back without manual pre/post balance math.
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

/**
 * Parsed transfers for one transaction signature. The caller matches `to`
 * against the receiving wallet.
 */
export async function getSolTxTransfers(heliusKey: string, signature: string): Promise<SolTransfer[]> {
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
  return transfers;
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
