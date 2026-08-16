/**
 * Client-side Moralis integration for the EVM rails (Ethereum + Base).
 * The deep-index API serves `Access-Control-Allow-Origin: *` with the
 * x-api-key header allowed, so the browser can call it directly.
 *
 * Used for:
 *  - verifying a customer payment by transaction hash (stablecoin transfer
 *    amount + recipient decoded from the tx logs)
 *  - wallet balance snapshots
 */

import { fetchWithBackoff } from './http';

const EVM_BASE = 'https://deep-index.moralis.io/api/v2.2';

export type EvmChain = 'eth' | 'base';

/** Canonical mainnet stablecoin contracts per chain (lowercase). */
const STABLES: Record<EvmChain, Record<string, { symbol: string; decimals: number }>> = {
  eth: {
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
    '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
    // PayPal USD (Paxos-issued) — Ethereum mainnet only, not on Base.
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8': { symbol: 'PYUSD', decimals: 6 },
  },
  base: {
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6 },
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2': { symbol: 'USDT', decimals: 6 },
  },
};

/** keccak256("Transfer(address,address,uint256)") */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function get(apiKey: string, url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithBackoff(url, { headers: { 'X-API-Key': apiKey, accept: 'application/json' } });
  } catch {
    throw new Error('Could not reach Moralis — check your network connection.');
  }
  if (!res.ok) {
    if (res.status === 429) throw new Error('Moralis is rate-limiting (429) — wait a few seconds and retry.');
    const body = await res.json().catch(() => null) as { message?: string } | null;
    // a bare 404 must still read as "not found" so the tx-lookup caller can
    // recognize it and explain indexing lag
    if (res.status === 404) throw new Error(body?.message || 'Not found (HTTP 404).');
    throw new Error(body?.message || `Moralis request failed (HTTP ${res.status}).`);
  }
  return res.json();
}

export type ChainTransfer = {
  token: string;       // 'USDC' | 'USDT' | 'PYUSD' | 'ETH'
  amount: number;      // whole units
  to: string;          // recipient address (lowercase)
  from: string | null;
  at: string | null;   // ISO timestamp of the block
};

/**
 * All stablecoin (and native ETH) transfers inside one transaction.
 * The caller matches `to` against the receiving wallet and sums amounts.
 */
export async function getEvmTxTransfers(apiKey: string, chain: EvmChain, txHash: string): Promise<ChainTransfer[]> {
  let d: {
    to_address?: string; from_address?: string; value?: string; block_timestamp?: string;
    receipt_status?: string;
    logs?: { address?: string; topic0?: string; topic1?: string; topic2?: string; data?: string }[];
  };
  try {
    d = await get(apiKey, `${EVM_BASE}/transaction/${txHash}?chain=${chain}`) as typeof d;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Moralis indexes a few minutes behind the chain head, so a tx that is
    // already visible on the block explorer can still 404 here — say so
    // instead of the misleading "no transaction found"
    if (/not found|no transaction/i.test(msg)) {
      const explorer = chain === 'base' ? 'Basescan' : 'Etherscan';
      throw new Error(`Transaction not indexed yet — Moralis runs a few minutes behind the chain. If ${explorer} already shows it, wait a minute and click Verify again (the hash stays saved). If it is not on ${explorer} either, check the hash and the network.`);
    }
    throw e;
  }
  if (d.receipt_status !== undefined && String(d.receipt_status) !== '1') {
    throw new Error('Transaction failed on-chain (receipt status 0).');
  }
  const at = d.block_timestamp || null;
  const transfers: ChainTransfer[] = [];

  const native = Number(d.value || 0) / 1e18;
  if (native > 0) {
    transfers.push({ token: 'ETH', amount: native, to: String(d.to_address || '').toLowerCase(), from: d.from_address || null, at });
  }

  for (const log of d.logs || []) {
    if ((log.topic0 || '').toLowerCase() !== TRANSFER_TOPIC) continue;
    const meta = STABLES[chain][String(log.address || '').toLowerCase()];
    if (!meta) continue; // an unrelated token must never be mistaken for a stablecoin payment
    const to = '0x' + String(log.topic2 || '').slice(-40).toLowerCase();
    const from = '0x' + String(log.topic1 || '').slice(-40).toLowerCase();
    const amount = parseInt(String(log.data || '0x0'), 16) / Math.pow(10, meta.decimals);
    if (amount > 0) transfers.push({ token: meta.symbol, amount, to, from, at });
  }
  return transfers;
}

export type WalletBalances = { usdc: number; usdt: number; pyusd: number; native: number };

/** Current stablecoin + native balances of an EVM wallet. */
export async function getEvmBalances(apiKey: string, chain: EvmChain, address: string): Promise<WalletBalances> {
  const nat = await get(apiKey, `${EVM_BASE}/${address}/balance?chain=${chain}`) as { balance?: string };
  const tokens = await get(apiKey, `${EVM_BASE}/${address}/erc20?chain=${chain}`) as
    Array<{ token_address?: string; balance?: string; decimals?: number }>;
  const out: WalletBalances = { usdc: 0, usdt: 0, pyusd: 0, native: Number(nat.balance || 0) / 1e18 };
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const meta = STABLES[chain][String(t.token_address || '').toLowerCase()];
    if (!meta) continue;
    const amt = Number(t.balance || 0) / Math.pow(10, Number(t.decimals ?? meta.decimals));
    if (meta.symbol === 'USDC') out.usdc += amt;
    if (meta.symbol === 'USDT') out.usdt += amt;
    if (meta.symbol === 'PYUSD') out.pyusd += amt;
  }
  return out;
}
