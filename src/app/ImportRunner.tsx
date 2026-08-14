import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useMutateAction } from '@uibakery/data';
import importUpsertOrder from '@/actions/orders/importUpsertOrder';
import upsertOrderItem from '@/actions/orders/upsertOrderItem';
import deleteOrderItemsNotIn from '@/actions/orders/deleteOrderItemsNotIn';
import importPayments from '@/actions/orders/importPayments';
import syncOrderStatus from '@/actions/orders/syncOrderStatus';
import { useApp } from '@/app/AppContext';
import { ParsedOrder } from '@/lib/parseOrderImport';
import { B44Cancellation } from '@/lib/mapB44Order';
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

type StartArgs = { groupBuyId: number; orders: ParsedOrder[]; cancellations: B44Cancellation[] };

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
export function importSourceKey({ groupBuyId, orders, cancellations }: StartArgs): string {
  return JSON.stringify([
    groupBuyId,
    orders.map(({ raw, ...rest }) => ({ ...rest, rawHash: hashStr(JSON.stringify(raw)) })),
    cancellations,
  ]);
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
  const [doSyncStatus] = useMutateAction(syncOrderStatus);

  const [job, setJob] = useState<ImportJob>(IDLE);
  // The loop lives across renders; the ref (not state) is the concurrency
  // gate so two rapid clicks can't both pass the running check.
  const activeRef = useRef(false);

  // startImport is a stable callback, so the long-running loop must read the
  // CURRENT user and mutate functions at execution time — a first-render
  // closure would freeze 'Admin' (useUser resolves late) into audit rows.
  const envRef = useRef({ userName, doUpsert, doUpsertItem, doPruneItems, doPayments, doSyncStatus });
  envRef.current = { userName, doUpsert, doUpsertItem, doPruneItems, doPayments, doSyncStatus };

  const importOne = async (o: ParsedOrder, gbId: number): Promise<ImportRowResult> => {
    const { userName, doUpsert, doUpsertItem, doPruneItems, doPayments } = envRef.current;
    // An empty item set would erase a previously imported order's items on
    // prune. Refuse it here for every source (pull and paste).
    if (o.items.length === 0) {
      throw new Error('Order has no line items — refusing to import (would erase existing items)');
    }
    // Cash-rail totals include the payment-processor gross-up; make the fee
    // explicit. Insurance is part of the known fees — without it the
    // derivation would mislabel insurance dollars as processor gross-up.
    const base = o.subtotal + o.tip + o.adminFee + o.shippingFee + o.shippingInsurance;
    const processorFee = o.paymentRail === 'cash' && o.total > base ? +(o.total - base).toFixed(2) : 0;

    // Items are written one row per product: UI Bakery's action layer rejects
    // multi-row inserts with repeated key columns, which is what silently
    // broke the old replaceOrderItems (and blocked payment sync behind it).
    // Duplicate SKU lines from the source are summed into one row first.
    // Summed in integer hundredths: quantities are 2-decimal values and the
    // write boundary rejects finer precision, so float addition (0.1 + 0.2 =
    // 0.30000000000000004) must never reach the qty param.
    const qtyBySku = new Map<string, { cents: number; directShip: boolean | undefined }>();
    for (const it of o.items) {
      const cur = qtyBySku.get(it.sku);
      qtyBySku.set(it.sku, {
        cents: (cur?.cents || 0) + Math.round(it.qty * 100),
        // merged duplicate-SKU lines reduce with OR: if ANY source line is
        // direct-shipped the merged row is; undefined only when no line knows
        directShip: cur?.directShip === undefined && it.directShip === undefined
          ? undefined : (cur?.directShip || it.directShip || false),
      });
    }
    const mergedItems = [...qtyBySku.entries()].map(([sku, v]) => ({ sku, qty: v.cents / 100, directShip: v.directShip }));

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
      shipping_insurance_usd: o.shippingInsurance,
      processor_fee_usd: processorFee,
      total_usd: o.total,
      placed_at: o.placedAt || '',
      customer_note: o.customerNote || '',
      raw_import: JSON.stringify(o.raw),
    })) as { id: number }[] | { id: number };
    const orderId = Array.isArray(upserted) ? upserted[0]?.id : upserted?.id;
    if (!orderId) throw new Error('Refused: this order number already exists under a different campaign');

    // Upsert every row FIRST and prove the whole replacement set is writable;
    // only then prune items removed upstream. A mid-loop failure leaves stale
    // extra items (a harmless superset, healed on re-run) — never a
    // destructively pruned partial state.
    let itemsWritten = 0;
    for (const it of mergedItems) {
      const res = await withRetry(() => doUpsertItem({
        order_id: orderId, group_buy_id: gbId, sku: it.sku, qty: it.qty,
        direct_ship: it.directShip === undefined ? '' : String(it.directShip),
        actor: userName,
      })) as unknown[] | null;
      if (Array.isArray(res) ? res.length > 0 : !!res) itemsWritten++;
    }
    if (itemsWritten !== mergedItems.length) {
      throw new Error(`Only ${itemsWritten}/${mergedItems.length} items matched campaign products`);
    }
    await withRetry(() => doPruneItems({ order_id: orderId, group_buy_id: gbId, items: JSON.stringify(mergedItems) }));

    if (o.payments.length > 0) {
      const method = o.paymentRail === 'cash' ? 'other' : o.paymentRail;
      // Hashes go one per call (multi-row inserts trip the same platform
      // validation); receipts go together in one call because the action
      // clears pending receipts per invocation — per-receipt calls would
      // each wipe the previous one.
      const hashes = o.payments.filter(p => p.kind === 'tx_hash');
      const receipts = o.payments.filter(p => p.kind === 'receipt');
      for (const p of hashes) {
        await withRetry(() => doPayments({ order_id: orderId, payments: JSON.stringify([{ kind: p.kind, value: p.value, method }]) }));
      }
      if (receipts.length > 0) {
        await withRetry(() => doPayments({ order_id: orderId, payments: JSON.stringify(receipts.map(p => ({ kind: p.kind, value: p.value, method: 'other' }))) }));
      }
    }

    return { orderNumber: o.orderNumber, ok: true, message: `${mergedItems.length} items, ${o.payments.length} payment refs` };
  };

  const run = async ({ groupBuyId, orders, cancellations }: StartArgs) => {
    const out: ImportRowResult[] = [];
    for (const o of orders) {
      try {
        out.push(await importOne(o, groupBuyId));
      } catch (e: unknown) {
        out.push({ orderNumber: o.orderNumber, ok: false, message: e instanceof Error ? e.message : 'Import failed' });
      }
      setJob(j => ({ ...j, results: [...out] }));
    }
    for (const c of cancellations) {
      try {
        const res = await withRetry(() => envRef.current.doSyncStatus({ order_number: c.orderNumber, group_buy_id: groupBuyId, status: c.status })) as { id: number }[] | { id: number } | null;
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
      total: args.orders.length + args.cancellations.length,
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
          ? <Loader2 className="w-4 h-4 animate-spin text-violet-600 shrink-0" />
          : failed > 0
            ? <XCircle className="w-4 h-4 text-red-600 shrink-0" />
            : <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" />}
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
        <div className="h-full bg-violet-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span>{failed > 0 ? `${failed} failed so far` : 'no failures'}</span>
        <Link to="/import" className="text-violet-600 hover:underline">details →</Link>
      </div>
    </div>
  );
}
