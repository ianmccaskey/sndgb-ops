import { lookupTxPayment, TxLookupResult } from '@/lib/verifyPayment';
import { networksForHash, shortHash, UPSTREAM_METHOD, CryptoMethod } from '@/lib/chains';
import { correctOrderRail, RailDeps } from '@/lib/railCorrection';

/*
 * The deterministic auto-reconcile pass (2026-10-25). It does, without
 * asking, exactly what the on-chain evidence settles and nothing the
 * evidence leaves open:
 *
 *  1. VERIFY every pending crypto payment on its recorded network — the
 *     Reconciliation page's Verify-all, run unattended (chain_verify).
 *  2. CROSS-CHECK a hash the recorded network does not know: a 0x hash is
 *     tried on the other EVM chain (ETH ↔ Base); a base58 signature has
 *     nowhere else to go. When EXACTLY ONE other network shows a transfer
 *     to our wallet, the payment is re-pointed there as pending
 *     (payment_auto_repointed, with the evidence) and verified on that
 *     network in the same breath. Two networks claiming the same hash, or
 *     none, is reported, not acted on.
 *  3. RAIL: an order whose verified money sits on one network that is not
 *     its rail is corrected through the same code the order sheet's button
 *     runs (local first, then the ordering-app push with its trail lines).
 *     A storefront order's rail follows its claims on every pull, so it is
 *     reported for the member to fix the claim; Base has no ordering-app
 *     value, so it is reported too.
 *
 * NEVER: reject a payment, set an override, price a native coin, move a
 * hash between orders, or touch a hash another order claims. Those are the
 * operator's calls — the assistant proposes them, the pass lists them
 * under "needs you". Every write is audited under the actor the caller
 * passes (the operator's name tagged as auto-reconcile), and a run that
 * changed anything writes one auto_recon_run summary row on the campaign.
 *
 * The lookups are the Verify button's (Moralis / Helius with the keys and
 * receiving wallets from Settings), paced like Verify-all. A missing key
 * skips that network's payments with a note; a transient provider error
 * skips that payment for this run.
 */

export type PendingPayment = {
  payment_id: number; method: string; tx_hash: string;
  order_id: number; order_number: string; total_usd: string;
};

export type RailCandidate = {
  order_id: number; order_number: string; external_id: string | null;
  payment_rail: string; source: string | null; verified_method: string;
};

export type AutoReconItemKind = 'verified' | 'mismatch' | 'repointed' | 'rail' | 'needs_you' | 'skipped' | 'error';

export type AutoReconItem = {
  kind: AutoReconItemKind;
  orderNumber: string;
  orderId: number;
  paymentId?: number;
  message: string;
};

export type AutoReconSummary = {
  groupBuyId: number;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  pendingSeen: number;
  verified: number;
  mismatch: number;
  repointed: number;
  railsCorrected: number;
  needsYou: number;
  skipped: number;
  errors: number;
  /** networks whose provider key is missing in Settings (their payments were skipped) */
  configMissing: string[];
  items: AutoReconItem[];
};

export type AutoReconDeps = {
  settings: Record<string, string>;
  /** audit actor for every write, e.g. "Ian (auto-reconcile)" */
  actor: string;
  listPending: (groupBuyId: number) => Promise<unknown>;
  recordVerification: (p: {
    payment_id: number; amount_usd: number; native_amount: string; native_symbol: string; value_at_pay_usd: string;
    status: 'verified' | 'mismatch'; notes: string; expected_method: string; actor: string;
  }) => Promise<unknown>;
  repoint: (p: {
    payment_id: number; order_id: number; expected_method: string; method: string; note: string; evidence: string; actor: string;
  }) => Promise<unknown>;
  listRailCandidates: (groupBuyId: number) => Promise<unknown>;
  rail: Pick<RailDeps, 'updateRail' | 'appendNote'>;
  logRun: (p: { group_buy_id: number; actor: string; detail: string }) => Promise<unknown>;
  /** injectable for tests; defaults to the real on-chain lookup */
  lookup?: (method: string, txHash: string, settings: Record<string, string>) => Promise<TxLookupResult>;
  /** injectable for tests; defaults to a real delay between lookups */
  sleep?: (ms: number) => Promise<void>;
};

/** The pace Verify-all uses: rarely hits a provider's per-second limit; the fetch layer's 429 backoff is the net. */
const LOOKUP_GAP_MS = 300;

/** The Settings key holding our receiving wallet on each network. */
const WALLET_KEY: Record<string, string> = { eth: 'eth_wallet_address', base: 'base_wallet_address', sol: 'sol_wallet_address' };

/**
 * Without a receiving wallet for the network, lookupTxPayment counts EVERY
 * transfer in the transaction and only notes that the amount was not
 * recipient-checked. An operator reads that note; an unattended pass must
 * not act on it — so a network with no wallet configured is treated like
 * one with no API key: its payments are skipped and the card says why.
 */
function missingWallet(method: string, settings: Record<string, string>): string | null {
  const key = WALLET_KEY[method];
  if (!key) return `${method} is not a network this pass verifies`;
  if ((settings[key] || '').trim()) return null;
  return `Set the ${method.toUpperCase()} receiving wallet address in Settings first — without it a lookup cannot tell our transfers from anyone else's, so the pass does not verify on ${method.toUpperCase()}.`;
}

type LookupOutcome =
  | { ok: true; res: TxLookupResult }
  | { ok: false; kind: 'config' | 'not_found' | 'no_transfer' | 'failed' | 'error'; message: string };

/** The lookup's operator-readable errors, sorted into what they mean for the pass. */
export function classifyLookupError(message: string): Exclude<LookupOutcome, { ok: true }>['kind'] {
  if (/API key/i.test(message)) return 'config';
  if (/not indexed|not found/i.test(message)) return 'not_found';
  if (/No transfer|No stablecoin/i.test(message)) return 'no_transfer';
  if (/failed on-chain/i.test(message)) return 'failed';
  return 'error';
}

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res.filter(x => x != null && typeof x === 'object') as T[];
  if (res && typeof res === 'object' && Array.isArray((res as { data?: unknown }).data)) return rowsOf<T>((res as { data: unknown }).data);
  return [];
}

function countOf(res: unknown, key: string): number {
  const r = (Array.isArray(res) ? res[0] : res) as Record<string, unknown> | null | undefined;
  return Number(r?.[key] ?? 0);
}

function wroteRows(res: unknown): boolean {
  return Array.isArray(res) ? res.length > 0 : !!res;
}

export async function runAutoRecon(groupBuyId: number, deps: AutoReconDeps): Promise<AutoReconSummary> {
  const lookup = deps.lookup ?? lookupTxPayment;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const startedAt = new Date().toISOString();
  const items: AutoReconItem[] = [];
  const configMissing = new Set<string>();
  const counts = { verified: 0, mismatch: 0, repointed: 0, railsCorrected: 0, needsYou: 0, skipped: 0, errors: 0 };
  const push = (it: AutoReconItem) => {
    items.push(it);
    if (it.kind === 'verified') counts.verified++;
    else if (it.kind === 'mismatch') counts.mismatch++;
    else if (it.kind === 'repointed') counts.repointed++;
    else if (it.kind === 'rail') counts.railsCorrected++;
    else if (it.kind === 'needs_you') counts.needsYou++;
    else if (it.kind === 'skipped') counts.skipped++;
    else counts.errors++;
  };

  let lookups = 0;
  const tryLookup = async (method: string, hash: string): Promise<LookupOutcome> => {
    const noWallet = missingWallet(method, deps.settings);
    if (noWallet) return { ok: false, kind: 'config', message: noWallet };
    if (lookups > 0) await sleep(LOOKUP_GAP_MS);
    lookups++;
    try {
      return { ok: true, res: await lookup(method, hash, deps.settings) };
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, kind: classifyLookupError(message), message };
    }
  };

  // Writes the lookup result the way the Verify button does: stablecoin
  // at face value → verified; native-only → mismatch until priced.
  const record = async (p: PendingPayment, onMethod: string, res: TxLookupResult, repointedFrom?: string): Promise<void> => {
    const status: 'verified' | 'mismatch' = res.amountUsd > 0 ? 'verified' : 'mismatch';
    const wrote = wroteRows(await deps.recordVerification({
      payment_id: p.payment_id,
      amount_usd: res.amountUsd,
      native_amount: res.nativeAmount != null ? String(res.nativeAmount) : '',
      native_symbol: res.nativeSymbol || '',
      value_at_pay_usd: '',
      status,
      notes: [res.note, '[auto-reconcile]'].filter(Boolean).join(' '),
      expected_method: onMethod,
      actor: deps.actor,
    }));
    if (!wrote) {
      push({ kind: 'skipped', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: 'no longer pending on that network when the result came back — nothing written' });
      return;
    }
    const where = repointedFrom ? `${onMethod.toUpperCase()} (was recorded as ${repointedFrom.toUpperCase()})` : onMethod.toUpperCase();
    if (status === 'verified') {
      push({ kind: repointedFrom ? 'repointed' : 'verified', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: `$${res.amountUsd.toFixed(2)} verified on ${where} — ${shortHash(p.tx_hash)}` });
    } else {
      push({ kind: repointedFrom ? 'repointed' : 'mismatch', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: `native ${res.nativeAmount} ${res.nativeSymbol} found on ${where} — needs USD pricing (set an override on the order)` });
      if (repointedFrom) push({ kind: 'needs_you', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: `native ${res.nativeAmount} ${res.nativeSymbol} on ${onMethod.toUpperCase()} needs USD pricing — set an override for the order's TOTAL received` });
    }
  };

  // ---- 1 + 2: pending payments -------------------------------------------
  const pending = rowsOf<PendingPayment>(await deps.listPending(groupBuyId))
    .filter(p => p.tx_hash && ['eth', 'sol', 'base'].includes(p.method));

  for (const p of pending) {
    const first = await tryLookup(p.method, p.tx_hash);
    if (first.ok) {
      await record(p, p.method, first.res);
      continue;
    }
    if (first.kind === 'config') {
      configMissing.add(p.method);
      push({ kind: 'skipped', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: first.message });
      continue;
    }
    if (first.kind === 'error') {
      push({ kind: 'error', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: `${p.method.toUpperCase()} lookup failed this run — ${first.message}` });
      continue;
    }
    if (first.kind === 'failed') {
      push({ kind: 'needs_you', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: `${shortHash(p.tx_hash)} failed on-chain on ${p.method.toUpperCase()} — not a payment; reject it on the order (reason required)` });
      continue;
    }

    // not found / no transfer on the recorded network: can the hash live
    // elsewhere? Only networks its shape fits, minus the one just tried.
    const candidates = networksForHash(p.tx_hash).filter(m => m !== p.method) as CryptoMethod[];
    const found: { method: CryptoMethod; res: TxLookupResult }[] = [];
    const elsewhere: string[] = [];
    for (const m of candidates) {
      const r = await tryLookup(m, p.tx_hash);
      if (r.ok) found.push({ method: m, res: r.res });
      else if (r.kind === 'config') { configMissing.add(m); elsewhere.push(`${m.toUpperCase()}: not checked (${r.message})`); }
      else elsewhere.push(`${m.toUpperCase()}: ${r.message}`);
    }

    if (found.length === 1) {
      const hit = found[0];
      const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
      const evidence = {
        recorded_network: p.method, recorded_result: first.message,
        found_network: hit.method, stablecoin_usd: hit.res.amountUsd, native_amount: hit.res.nativeAmount, native_symbol: hit.res.nativeSymbol,
        other_networks: elsewhere,
      };
      const note = `${ts} auto-reconcile: ${p.method.toUpperCase()} does not know this hash (${first.message.slice(0, 120)}); found on ${hit.method.toUpperCase()} paying our wallet${hit.res.amountUsd > 0 ? ` $${hit.res.amountUsd.toFixed(2)}` : ''} — re-pointed to ${hit.method.toUpperCase()}.`;
      const repointed = countOf(await deps.repoint({
        payment_id: p.payment_id, order_id: p.order_id, expected_method: p.method, method: hit.method,
        note, evidence: JSON.stringify(evidence), actor: deps.actor,
      }), 'repointed');
      if (!repointed) {
        push({ kind: 'skipped', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: `found on ${hit.method.toUpperCase()} but the payment changed before it could be re-pointed — nothing written` });
        continue;
      }
      await record(p, hit.method, hit.res, p.method);
      continue;
    }
    if (found.length > 1) {
      push({ kind: 'needs_you', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id, message: `${shortHash(p.tx_hash)} shows a transfer to our wallet on ${found.map(f => f.method.toUpperCase()).join(' AND ')} — decide by hand which network this payment is on` });
      continue;
    }
    const tried = [`${p.method.toUpperCase()}: ${first.message}`, ...elsewhere];
    push({
      kind: 'needs_you', orderNumber: p.order_number, orderId: p.order_id, paymentId: p.payment_id,
      message: `${shortHash(p.tx_hash)} not found paying our wallet on any network it fits — ${tried.join(' · ')}${/not indexed/i.test(first.message) ? ' (if it is recent, the next run will try again)' : ''}`,
    });
  }

  // ---- 3: rails ------------------------------------------------------------
  const railCandidates = rowsOf<RailCandidate>(await deps.listRailCandidates(groupBuyId));
  for (const c of railCandidates) {
    const target = c.verified_method;
    if (c.source === 'storefront') {
      push({ kind: 'needs_you', orderNumber: c.order_number, orderId: c.order_id, message: `rail is ${c.payment_rail.toUpperCase()} but the verified payment is on ${target.toUpperCase()} — a storefront order's rail follows its claim on every pull, so the member's claim must be corrected on the storefront` });
      continue;
    }
    if (!UPSTREAM_METHOD[target]) {
      push({ kind: 'needs_you', orderNumber: c.order_number, orderId: c.order_id, message: `rail is ${c.payment_rail.toUpperCase()} but the verified payment is on ${target.toUpperCase()} — this app has no ${target.toUpperCase()} rail value the ordering app knows, so the rail cannot be corrected safely` });
      continue;
    }
    // a pasted order (no upstream id, not created here) would have its rail
    // reverted by the next paste — a manual order would not
    if (!c.external_id && c.source !== 'manual') {
      push({ kind: 'needs_you', orderNumber: c.order_number, orderId: c.order_id, message: `rail is ${c.payment_rail.toUpperCase()} but the verified payment is on ${target.toUpperCase()} — this order was pasted with no upstream id, so correct the rail in the source row and paste again` });
      continue;
    }
    try {
      const r = await correctOrderRail(
        { id: c.order_id, external_id: c.external_id, payment_rail: c.payment_rail, source: c.source },
        target,
        { ...deps.rail, settings: deps.settings, actor: deps.actor, tag: ' [auto-reconcile]' },
      );
      if (r.ok) push({ kind: 'rail', orderNumber: c.order_number, orderId: c.order_id, message: `rail ${c.payment_rail.toUpperCase()} → ${target.toUpperCase()}${c.external_id ? ', pushed to the ordering app' : ' (manual order, local)'}` });
      else push({ kind: r.localWritten ? 'needs_you' : 'skipped', orderNumber: c.order_number, orderId: c.order_id, message: r.message });
    } catch (e: unknown) {
      push({ kind: 'error', orderNumber: c.order_number, orderId: c.order_id, message: `rail correction failed — ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const summary: AutoReconSummary = {
    groupBuyId, trigger: '', startedAt, finishedAt: new Date().toISOString(),
    pendingSeen: pending.length, ...counts,
    configMissing: [...configMissing], items,
  };

  // one summary row per run that changed something; the writes themselves
  // are already audited one by one
  if (counts.verified + counts.mismatch + counts.repointed + counts.railsCorrected > 0) {
    try {
      await deps.logRun({
        group_buy_id: groupBuyId, actor: deps.actor,
        detail: JSON.stringify({
          started_at: startedAt, finished_at: summary.finishedAt, pending_seen: pending.length,
          verified: counts.verified, mismatch: counts.mismatch, repointed: counts.repointed, rails_corrected: counts.railsCorrected,
          needs_you: counts.needsYou, skipped: counts.skipped, errors: counts.errors,
          changes: items.filter(i => i.kind === 'verified' || i.kind === 'mismatch' || i.kind === 'repointed' || i.kind === 'rail')
            .map(i => ({ kind: i.kind, order: i.orderNumber, payment_id: i.paymentId ?? null, what: i.message })),
        }),
      });
    } catch {
      push({ kind: 'error', orderNumber: '—', orderId: 0, message: 'the run summary audit row could not be written (every individual change is still audited)' });
      summary.errors++;
    }
  }
  return summary;
}
