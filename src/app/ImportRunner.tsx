import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutateAction } from '@uibakery/data';
import importUpsertOrder from '@/actions/orders/importUpsertOrder';
import upsertOrderItem from '@/actions/orders/upsertOrderItem';
import deleteOrderItemsNotIn from '@/actions/orders/deleteOrderItemsNotIn';
import importPayments from '@/actions/orders/importPayments';
import noteStorefrontClaimConflict from '@/actions/storefront/noteStorefrontClaimConflict';
import syncStorefrontRejectedClaims from '@/actions/storefront/syncStorefrontRejectedClaims';
import releaseCancelledStorefrontClaims from '@/actions/storefront/releaseCancelledStorefrontClaims';
import syncOrderStatus from '@/actions/orders/syncOrderStatus';
import { useApp } from '@/app/AppContext';
import { ParsedOrder } from '@/lib/parseOrderImport';
import { B44Cancellation, ClaimRelease } from '@/lib/mapB44Order';
import { Loader2, CheckCircle2, XCircle, X } from 'lucide-react';

/**
 * Runs order imports OUTSIDE the Import page's component tree, so navigating
 * away doesn't kill (or orphan) a run in progress. The Import page hands the
 * validated order set to startImport() and reads progress back from here; the
 * floating ImportProgressWidget (mounted in the app shell) shows the same
 * progress on every other page.
 *
 * One run at a time: startImport refuses while a run is active. The job is
 * bound to the campaign it was started for — progress rows only render on the
 * Import page when the selected campaign matches.
 */

export type ImportRowResult = { orderNumber: string; ok: boolean; message: string };

/**
 * The row to show for an order: its LATEST result. An order can collect
 * several in one run (a pre-pass note that stale claims were released, then
 * its import result, or an abort marker) and the last one is the verdict.
 */
export function lastResultFor(results: ImportRowResult[], orderNumber: string): ImportRowResult | undefined {
  for (let i = results.length - 1; i >= 0; i--) if (results[i].orderNumber === orderNumber) return results[i];
  return undefined;
}

export type ImportJob = {
  running: boolean;
  forGroupBuyId: number | null;
  /** content snapshot of the input this run processed — see importSourceKey */
  sourceKey: string | null;
  total: number;
  results: ImportRowResult[];
  /** set when the run completes; cleared by dismiss() */
  finished: boolean;
};

const IDLE: ImportJob = { running: false, forGroupBuyId: null, sourceKey: null, total: 0, results: [], finished: false };

/**
 * Retry wrapper for the import's database calls. A bulk import fires hundreds
 * of rapid sequential queries and UI Bakery's gateway occasionally 502s under
 * the burst ("Failed to request http://.../postgres/query, response
 * status=502") — transient transport failures, not data problems. Retrying is
 * SAFE here because every import-path action is idempotent by design (order
 * and item upserts, NOT-EXISTS-guarded payment inserts, prune, status sync):
 * a request that actually landed before its response was lost re-runs to the
 * same end state. Only transport-shaped errors retry; SQL/data errors fail
 * immediately and surface per-order like before.
 */
const TRANSIENT = /failed to request|response status=5\d\d|network|timeout|econn|socket/i;
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  const delays = [500, 2000]; // total 3 attempts
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt >= delays.length || !TRANSIENT.test(msg)) throw e;
      await new Promise(r => setTimeout(r, delays[attempt]));
    }
  }
}

type StartArgs = {
  groupBuyId: number;
  orders: ParsedOrder[];
  cancellations: B44Cancellation[];
  /** claims the source has rejected, from EVERY source row (also rows that
   * failed validation and are not in `orders`) — released before any import */
  releases?: ClaimRelease[];
};

/**
 * Compact deterministic fingerprint for bulky raw payloads: two independent
 * 32-bit hashes (djb2 + sdbm) plus the length — ~64 bits of separation, so a
 * changed payload mapping to the same fingerprint is not a realistic event
 * for this UI equality check (unlike a single 32-bit hash).
 */
function hashStr(s: string): string {
  let a = 5381;
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = ((a << 5) + a + c) | 0;
    b = (c + (b << 6) + (b << 16) - b) | 0;
  }
  return `${a}:${b}:${s.length}`;
}

/**
 * Content key for an import input. The Import page shows per-row results only
 * while its CURRENT parsed input matches the job's key — editing the paste
 * (or re-pulling different data) must not keep showing results from the old
 * payload under the same order numbers. `raw` participates as a hash, not
 * verbatim: it IS persisted by the import (raw_import), so a re-pull that
 * changes only unmapped source fields still needs a fresh run — but the full
 * JSON of every order would make the key needlessly huge.
 */
export function importSourceKey({ groupBuyId, orders, cancellations, releases }: StartArgs): string {
  return JSON.stringify([
    groupBuyId,
    orders.map(({ raw, ...rest }) => ({ ...rest, rawHash: hashStr(JSON.stringify(raw)) })),
    cancellations,
    releases ?? [],
  ]);
}

const canonHash = (h: string) => (/^0x[0-9a-fA-F]{64}$/.test(h) ? h.toLowerCase() : h);

/**
 * Cancelled storefront orders whose still-live claims collide with a hash a
 * LIVE order in this pull claims — the only cancelled copies worth touching
 * (a cancelled order's hash nobody else wants is history, left for the
 * operator). Shared by the runner's pre-pass and the progress total.
 */
function cancelledReleases(orders: ParsedOrder[], cancellations: B44Cancellation[]): { orderNumber: string; hashes: { hash: string; claimant: string }[] }[] {
  const claimant = new Map<string, string>();
  for (const o of orders) for (const p of o.payments) if (p.kind === 'tx_hash') claimant.set(canonHash(p.value), o.orderNumber);
  const out: { orderNumber: string; hashes: { hash: string; claimant: string }[] }[] = [];
  for (const c of cancellations) {
    const hashes = (c.liveClaims ?? [])
      .map(l => canonHash(l.hash))
      .filter(h => claimant.has(h))
      .map(h => ({ hash: h, claimant: claimant.get(h) as string }));
    if (hashes.length > 0) out.push({ orderNumber: c.orderNumber, hashes });
  }
  return out;
}

type RunnerApi = {
  job: ImportJob;
  /** Returns false when a run is already active. */
  startImport: (args: StartArgs) => boolean;
  dismiss: () => void;
};

const RunnerCtx = createContext<RunnerApi | null>(null);

export function useImportRunner(): RunnerApi {
  const ctx = useContext(RunnerCtx);
  if (!ctx) throw new Error('useImportRunner must be used within ImportRunnerProvider');
  return ctx;
}

export function ImportRunnerProvider({ children }: { children: React.ReactNode }) {
  const { userName } = useApp();
  const [doUpsert] = useMutateAction(importUpsertOrder);
  const [doUpsertItem] = useMutateAction(upsertOrderItem);
  const [doPruneItems] = useMutateAction(deleteOrderItemsNotIn);
  const [doPayments] = useMutateAction(importPayments);
  const [doClaimConflict] = useMutateAction(noteStorefrontClaimConflict);
  const [doRejectedClaims] = useMutateAction(syncStorefrontRejectedClaims);
  const [doReleaseCancelled] = useMutateAction(releaseCancelledStorefrontClaims);
  const [doSyncStatus] = useMutateAction(syncOrderStatus);

  const [job, setJob] = useState<ImportJob>(IDLE);
  // The loop lives across renders; the ref (not state) is the concurrency
  // gate so two rapid clicks can't both pass the running check.
  const activeRef = useRef(false);

  // startImport is a stable callback, so the long-running loop must read the
  // CURRENT user and mutate functions at execution time — a first-render
  // closure would freeze 'Admin' (useUser resolves late) into audit rows.
  const envRef = useRef({ userName, doUpsert, doUpsertItem, doPruneItems, doPayments, doClaimConflict, doRejectedClaims, doReleaseCancelled, doSyncStatus });
  envRef.current = { userName, doUpsert, doUpsertItem, doPruneItems, doPayments, doClaimConflict, doRejectedClaims, doReleaseCancelled, doSyncStatus };

  const importOne = async (o: ParsedOrder, gbId: number, heldByCancelled: Map<string, { orderNumber: string; status: string }>): Promise<ImportRowResult> => {
    const { userName, doUpsert, doUpsertItem, doPruneItems, doPayments, doClaimConflict } = envRef.current;
    // An empty item set would erase a previously imported order's items on
    // prune. Refuse it here for every source (pull and paste).
    if (o.items.length === 0) {
      throw new Error('Order has no line items — refusing to import (would erase existing items)');
    }
    // Cash-rail totals include the payment-processor gross-up; make the fee
    // explicit. Insurance is part of the known fees — without it the
    // derivation would mislabel insurance dollars as processor gross-up.
    const base = o.subtotal + o.tip + o.adminFee + o.shippingFee + (o.shippingInsurance ?? 0);
    // A source that states the gross-up (storefront) wins: its totals also
    // carry split-kit fees, which the residual would otherwise mislabel.
    const processorFee = o.processorFee != null
      ? o.processorFee
      : (o.paymentRail === 'cash' && o.total > base ? +(o.total - base).toFixed(2) : 0);

    // Items are written one row per product: UI Bakery's action layer rejects
    // multi-row inserts with repeated key columns, which is what silently
    // broke the old replaceOrderItems (and blocked payment sync behind it).
    // Duplicate SKU lines from the source are summed into one row first.
    // Summed in integer hundredths: quantities are 2-decimal values and the
    // write boundary rejects finer precision, so float addition (0.1 + 0.2 =
    // 0.30000000000000004) must never reach the qty param.
    const qtyBySku = new Map<string, { cents: number; directShip: boolean | undefined; unitPriceUsd: number | undefined; splitFeeUsd: number | undefined }>();
    for (const it of o.items) {
      const cur = qtyBySku.get(it.sku);
      qtyBySku.set(it.sku, {
        cents: (cur?.cents || 0) + Math.round(it.qty * 100),
        // merged duplicate-SKU lines reduce with OR: if ANY source line is
        // direct-shipped the merged row is; undefined only when no line knows
        directShip: cur?.directShip === undefined && it.directShip === undefined
          ? undefined : (cur?.directShip || it.directShip || false),
        // order-time price snapshots (storefront): first line's values win;
        // a source never prices one SKU two ways on one order
        unitPriceUsd: cur?.unitPriceUsd ?? it.unitPriceUsd,
        splitFeeUsd: cur?.splitFeeUsd ?? it.splitFeeUsd,
      });
    }
    const mergedItems = [...qtyBySku.entries()].map(([sku, v]) => ({
      sku, qty: v.cents / 100, directShip: v.directShip,
      // split_fee rides along for the header upsert's per-line snapshot
      ...(v.splitFeeUsd !== undefined ? { split_fee: v.splitFeeUsd } : {}),
      unitPriceUsd: v.unitPriceUsd, splitFeeUsd: v.splitFeeUsd,
    }));

    const upserted = await withRetry(() => doUpsert({
      // the header upsert adopts any locally-added row whose SKU is in this
      // list ATOMICALLY with the total update — a failure later in this
      // function can never leave a product double-billed
      items: JSON.stringify(mergedItems),
      group_buy_id: gbId,
      order_number: o.orderNumber,
      external_id: o.externalId || '',
      customer_name: o.customerName,
      email: o.email || '',
      phone: o.phone || '',
      discord: o.discord || '',
      payment_rail: o.paymentRail,
      address_line1: o.addressLine1 || '',
      address_line2: o.addressLine2 || '',
      city: o.city || '',
      state_code: o.stateCode || '',
      postal_code: o.postalCode || '',
      subtotal_usd: o.subtotal,
      tip_usd: o.tip,
      admin_fee_usd: o.adminFee,
      shipping_fee_usd: o.shippingFee,
      shipping_insurance_usd: o.shippingInsurance === null ? '' : String(o.shippingInsurance),
      processor_fee_usd: processorFee,
      total_usd: o.total,
      placed_at: o.placedAt || '',
      customer_note: o.customerNote || '',
      raw_import: JSON.stringify(o.raw),
    })) as { id: number }[] | { id: number };
    const orderId = Array.isArray(upserted) ? upserted[0]?.id : upserted?.id;
    if (!orderId) throw new Error('Refused: this order number already exists under a different campaign or from a different source (ordering app vs storefront)');

    // Upsert every row FIRST and prove the whole replacement set is writable;
    // only then prune items removed upstream. A mid-loop failure leaves stale
    // extra items (a harmless superset, healed on re-run) — never a
    // destructively pruned partial state.
    let itemsWritten = 0;
    for (const it of mergedItems) {
      const res = await withRetry(() => doUpsertItem({
        order_id: orderId, group_buy_id: gbId, sku: it.sku, qty: it.qty,
        direct_ship: it.directShip === undefined ? '' : String(it.directShip),
        // blank = price from the campaign product (ordering app, paste)
        unit_price_usd: it.unitPriceUsd === undefined ? '' : String(it.unitPriceUsd),
        split_fee_usd: it.splitFeeUsd === undefined ? '' : String(it.splitFeeUsd),
        actor: userName,
      })) as unknown[] | null;
      if (Array.isArray(res) ? res.length > 0 : !!res) itemsWritten++;
    }
    if (itemsWritten !== mergedItems.length) {
      throw new Error(`Only ${itemsWritten}/${mergedItems.length} items matched campaign products`);
    }
    await withRetry(() => doPruneItems({ order_id: orderId, group_buy_id: gbId, items: JSON.stringify(mergedItems) }));

    let skippedHashes = 0;
    const blocked: string[] = [];
    if (o.payments.length > 0) {
      const method = o.paymentRail === 'cash' ? 'other' : o.paymentRail;
      // Hashes go one per call (multi-row inserts trip the same platform
      // validation); receipts go together in one call because the action
      // clears pending receipts per invocation — per-receipt calls would
      // each wipe the previous one.
      // A source that states each claim's method (storefront) wins over the
      // order header's rail: a claim is imported on the network it was made on.
      const hashes = o.payments.filter(p => p.kind === 'tx_hash');
      const receipts = o.payments.filter(p => p.kind === 'receipt');
      for (const p of hashes) {
        const res = await withRetry(() => doPayments({ order_id: orderId, payments: JSON.stringify([{ kind: p.kind, value: p.value, method: p.method ?? method }]) })) as { hashes_added?: number | string }[] | null;
        // 0 added = the hash already sits on a non-rejected payment (this or
        // another order) or was rejected here — not a new payment, but not
        // silent either: counted and shown in the row result
        if (Array.isArray(res) && res[0] && Number(res[0].hashes_added ?? 0) === 0) {
          skippedHashes++;
          // held by a CANCELLED storefront order's verified copy: the pre-pass
          // could not release it (money this app saw land), so this order
          // imports short until an operator moves that payment by hand
          const held = heldByCancelled.get(canonHash(p.value));
          if (held) blocked.push(`tx ${p.value.slice(0, 10)}…${p.value.slice(-6)} is ${held.status} on cancelled ${held.orderNumber}`);
        }
      }
      if (receipts.length > 0) {
        await withRetry(() => doPayments({ order_id: orderId, payments: JSON.stringify(receipts.map(p => ({ kind: p.kind, value: p.value, method: p.method ?? 'other' }))) }));
      }
    }

    // A source that reports the same hash on several of its orders (the
    // storefront) hands the duplicate here as raw.claim_conflicts: leave a
    // dated line on THIS order's admin notes so whoever reconciles sees both
    // claimants, instead of one order looking short for no visible reason.
    // The action is idempotent per (order, hash) — a retried request or the
    // next re-import of the same conflict writes nothing — so withRetry is safe.
    let conflictNoted = 0;
    if (o.raw.claim_conflicts) {
      try {
        const mine = JSON.parse(o.raw.claim_conflicts) as { txHash: string; others: string[] }[];
        const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
        for (const c of mine) {
          const line = `${ts} storefront: tx ${c.txHash.slice(0, 10)}…${c.txHash.slice(-6)} is also claimed by ${c.others.join(', ')} — one order holds it here; reject the wrong claim.`;
          const res = await withRetry(() => doClaimConflict({ order_id: orderId, tx_hash: c.txHash, others: JSON.stringify(c.others), note: line, actor: userName })) as unknown[] | null;
          if (Array.isArray(res) ? res.length > 0 : !!res) conflictNoted++;
        }
      } catch {
        // a malformed marker must not fail the import of a valid order
      }
    }

    // (claims the storefront rejected are released in run()'s pre-pass, for
    // every order in the pull, BEFORE any payment import — never here, where
    // an earlier order's stale hash could still block this one)

    const extras = [
      skippedHashes > 0 ? `${skippedHashes} hash(es) already held elsewhere` : '',
      conflictNoted > 0 ? `${conflictNoted} claim conflict(s) noted on the order` : '',
    ].filter(Boolean);
    const summary = `${mergedItems.length} items, ${o.payments.length} payment refs${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
    if (blocked.length > 0) {
      return { orderNumber: o.orderNumber, ok: false, message: `${summary} — payment NOT attached: ${blocked.join('; ')}. Reject or reassign it on the cancelled order, then pull again.` };
    }
    return { orderNumber: o.orderNumber, ok: true, message: summary };
  };

  const run = async ({ groupBuyId, orders, cancellations, releases = [] }: StartArgs) => {
    const out: ImportRowResult[] = [];
    // FIRST: every claim the storefront has rejected — on live orders, on
    // cancelled ones, and on rows the validator skipped (the mapper collects
    // `releases` from every source row, not from the orders it produced).
    // Their local pending copies must be released before ANY order below
    // imports a payment: orders import in source order, so a later (or
    // skipped) row's stale hash would otherwise block an earlier order's
    // legitimate claim within the same run. Idempotent, so it is safe on
    // every pull.
    // FAIL CLOSED. A release that did not provably succeed may have left a
    // stale non-rejected hash in place, and such a hash blocks every other
    // claimant — importing anything now could attach a payment to the wrong
    // order or drop it from the right one. Nothing is imported; every row
    // says so, and the next pull retries from scratch.
    const abort = (at: string, why: string) => {
      out.push({ orderNumber: at, ok: false, message: `${why} — import aborted before any order or payment was touched` });
      const aborted = 'Not imported: releasing a stale storefront claim failed earlier in this run, so no order or payment was touched. Fix the cause and pull again.';
      for (const o of orders) if (o.orderNumber !== at) out.push({ orderNumber: o.orderNumber, ok: false, message: aborted });
      for (const c of cancellations) if (c.orderNumber !== at) out.push({ orderNumber: c.orderNumber, ok: false, message: aborted });
      setJob(j => ({ ...j, results: [...out] }));
    };
    for (const r of releases) {
      try {
        const res = await withRetry(() => envRef.current.doRejectedClaims({ order_number: r.orderNumber, group_buy_id: groupBuyId, rejected: JSON.stringify(r.rejected), actor: envRef.current.userName })) as unknown[] | null;
        const n = Array.isArray(res) ? res.length : (res ? 1 : 0);
        if (n > 0) out.push({ orderNumber: r.orderNumber, ok: true, message: `${n} stale local payment(s) rejected to match the storefront` });
        setJob(j => ({ ...j, results: [...out] }));
      } catch (e: unknown) {
        abort(r.orderNumber, e instanceof Error ? e.message : 'Failed to release rejected claims');
        return;
      }
    }
    // SECOND: a CANCELLED storefront order may still hold, here, a hash that
    // a live order in this pull claims (its claim was imported while the
    // order was live; this app keeps a hash on one order). A PENDING copy is
    // released to the live claimant; a VERIFIED/MISMATCH copy is money this
    // app saw land and is never moved by a pull — it is remembered so the
    // live order's row turns red instead of quietly importing short.
    const heldByCancelled = new Map<string, { orderNumber: string; status: string }>();
    for (const rel of cancelledReleases(orders, cancellations)) {
      try {
        const res = await withRetry(() => envRef.current.doReleaseCancelled({ order_number: rel.orderNumber, group_buy_id: groupBuyId, hashes: JSON.stringify(rel.hashes), actor: envRef.current.userName })) as { hash: string; outcome: string; status: string }[] | null;
        const rows = Array.isArray(res) ? res : [];
        const released = rows.filter(x => x.outcome === 'released').length;
        const held = rows.filter(x => x.outcome === 'held');
        for (const h of held) heldByCancelled.set(canonHash(String(h.hash)), { orderNumber: rel.orderNumber, status: String(h.status) });
        if (released > 0 || held.length > 0) {
          out.push({
            orderNumber: rel.orderNumber,
            ok: held.length === 0,
            message: [
              released > 0 ? `${released} pending hash(es) released to the live claimant` : '',
              held.length > 0 ? `${held.length} verified hash(es) still held on this cancelled order — reject or reassign by hand` : '',
            ].filter(Boolean).join(' · '),
          });
        }
        setJob(j => ({ ...j, results: [...out] }));
      } catch (e: unknown) {
        abort(rel.orderNumber, e instanceof Error ? e.message : "Failed to release a cancelled order's claims");
        return;
      }
    }
    for (const o of orders) {
      try {
        out.push(await importOne(o, groupBuyId, heldByCancelled));
      } catch (e: unknown) {
        out.push({ orderNumber: o.orderNumber, ok: false, message: e instanceof Error ? e.message : 'Import failed' });
      }
      setJob(j => ({ ...j, results: [...out] }));
    }
    for (const c of cancellations) {
      try {
        const res = await withRetry(() => envRef.current.doSyncStatus({ order_number: c.orderNumber, group_buy_id: groupBuyId, status: c.status, source: c.source ?? '' })) as { id: number }[] | { id: number } | null;
        const touched = Array.isArray(res) ? res.length > 0 : !!res;
        out.push({
          orderNumber: c.orderNumber,
          ok: true,
          message: touched ? `marked ${c.status} (source: ${c.sourceStatus})` : `${c.sourceStatus} upstream — not present locally, nothing to do`,
        });
      } catch (e: unknown) {
        out.push({ orderNumber: c.orderNumber, ok: false, message: e instanceof Error ? e.message : `Failed to mark ${c.status}` });
      }
      setJob(j => ({ ...j, results: [...out] }));
    }
  };

  const startImport = useCallback((args: StartArgs): boolean => {
    if (activeRef.current) return false;
    activeRef.current = true;
    setJob({
      running: true,
      forGroupBuyId: args.groupBuyId,
      sourceKey: importSourceKey(args),
      // + one row per pre-pass release (rejected claims; cancelled-order hashes)
      total: args.orders.length + args.cancellations.length
        + (args.releases?.length ?? 0)
        + cancelledReleases(args.orders, args.cancellations).length,
      results: [],
      finished: false,
    });
    // Fire and forget — the loop keeps running wherever the user navigates.
    run(args)
      .catch(() => { /* per-row errors are already captured in results */ })
      .finally(() => {
        activeRef.current = false;
        setJob(j => ({ ...j, running: false, finished: true }));
      });
    return true;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = useCallback(() => {
    setJob(j => (j.running ? j : IDLE));
  }, []);

  return <RunnerCtx.Provider value={{ job, startImport, dismiss }}>{children}</RunnerCtx.Provider>;
}

/**
 * Floating progress card (bottom-right, all pages except /import — the page
 * itself shows per-order detail). Visible while a run is active and stays as
 * a summary after it finishes until dismissed.
 */
export function ImportProgressWidget() {
  const { job, dismiss } = useImportRunner();
  const location = useLocation();
  if (location.pathname === '/import') return null;
  if (!job.running && !job.finished) return null;

  const done = job.results.length;
  const failed = job.results.filter(r => !r.ok).length;
  const pct = job.total > 0 ? Math.round((done / job.total) * 100) : 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-lg border bg-background shadow-lg p-3 text-sm">
      <div className="flex items-center gap-2">
        {job.running
          ? <Loader2 className="w-4 h-4 animate-spin text-cyan-300 shrink-0" />
          : failed > 0
            ? <XCircle className="w-4 h-4 text-rose-400 shrink-0" />
            : <CheckCircle2 className="w-4 h-4 text-emerald-300 shrink-0" />}
        <span className="font-medium flex-1">
          {job.running ? `Importing orders… ${done}/${job.total}` : `Import finished — ${done - failed} ok${failed > 0 ? `, ${failed} failed` : ''}`}
        </span>
        {!job.running && (
          <button type="button" onClick={dismiss} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
      <div className="mt-2 h-1.5 rounded bg-muted overflow-hidden">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{failed > 0 ? `${failed} failed so far` : 'no failures'}</span>
        <Link to="/import" className="text-cyan-300 hover:underline">details →</Link>
      </div>
    </div>
  );
}
