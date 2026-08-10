import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import listProducts from '@/actions/products/listProducts';
import importUpsertOrder from '@/actions/orders/importUpsertOrder';
import upsertOrderItem from '@/actions/orders/upsertOrderItem';
import deleteOrderItemsNotIn from '@/actions/orders/deleteOrderItemsNotIn';
import importPayments from '@/actions/orders/importPayments';
import syncOrderStatus from '@/actions/orders/syncOrderStatus';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD } from '@/lib/fmt';
import { parseOrderPaste, ParsedOrder, ParseResult } from '@/lib/parseOrderImport';
import { B44_DEFAULT_APP_ID, B44Order, listB44Orders } from '@/lib/base44';
import { mapB44Orders, MappedOrders } from '@/lib/mapB44Order';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ClipboardPaste, CloudDownload, CheckCircle2, XCircle } from 'lucide-react';

type CampaignProduct = { sku_code: string };
type CatalogProduct = { external_id: string | null; sku_code: string };

type RowState = { orderNumber: string; ok: boolean; message: string };

const EMPTY_RESULT: ParseResult = { orders: [], errors: [] };

export function ImportPage() {
  const { groupBuyId, groupBuy, settings } = useApp();
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<RowState[]>([]);

  const enabled = groupBuyId != null;
  const [rawProducts] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const campaignSkus = useMemo(
    () => new Set(rows<CampaignProduct>(rawProducts).map(p => p.sku_code)),
    [rawProducts],
  );
  const [rawCatalog, catalogLoading] = useLoadAction(listProducts, [], {});
  const skuByExternalId = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of rows<CatalogProduct>(rawCatalog)) {
      if (p.external_id) m.set(p.external_id, p.sku_code);
    }
    return m;
  }, [rawCatalog]);

  const [doUpsert] = useMutateAction(importUpsertOrder);
  const [doUpsertItem] = useMutateAction(upsertOrderItem);
  const [doPruneItems] = useMutateAction(deleteOrderItemsNotIn);
  const [doPayments] = useMutateAction(importPayments);
  const [doSyncStatus] = useMutateAction(syncOrderStatus);

  // Ordering-app pull — same preview/import flow as paste, different source.
  const cfg = useMemo(() => ({
    appId: settings.base44_app_id || B44_DEFAULT_APP_ID,
    token: settings.base44_token || '',
  }), [settings.base44_app_id, settings.base44_token]);
  const canPull = !!cfg.token && !!groupBuy?.external_id;
  // Raw pulled orders stay bound to the campaign they were pulled for; the
  // ParsedOrder mapping is derived below so it re-runs when the catalog loads
  // and goes inert the moment the campaign selector changes.
  const [pulled, setPulled] = useState<{ forGroupBuyId: number; orders: B44Order[] } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState('');

  const pull = async () => {
    if (!canPull || !groupBuy?.external_id || groupBuyId == null) return;
    const forGroupBuyId = groupBuyId;
    setPulling(true); setPullError(''); setResults([]);
    try {
      const orders = await listB44Orders(cfg, groupBuy.external_id);
      setPulled({ forGroupBuyId, orders });
      setText('');
    } catch (e: unknown) {
      setPullError(e instanceof Error ? e.message : 'Failed to pull orders');
    } finally {
      setPulling(false);
    }
  };

  // Pull automatically once per campaign, only after the catalog has loaded —
  // the identity mapping is meaningless against an unloaded catalog.
  const autoPulledFor = useRef<number | null>(null);
  useEffect(() => {
    if (canPull && !catalogLoading && groupBuyId != null && autoPulledFor.current !== groupBuyId) {
      autoPulledFor.current = groupBuyId;
      pull();
    }
  }, [canPull, catalogLoading, groupBuyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setResults([]); }, [groupBuyId]);

  const pulledMapped = useMemo<MappedOrders | null>(
    () => (pulled && pulled.forGroupBuyId === groupBuyId ? mapB44Orders(pulled.orders, skuByExternalId) : null),
    [pulled, groupBuyId, skuByExternalId],
  );

  const parsed = useMemo(
    () => (text.trim() !== '' ? parseOrderPaste(text) : pulledMapped ?? EMPTY_RESULT),
    [text, pulledMapped],
  );

  // Pre-flight: every SKU in every order must exist as a campaign product,
  // otherwise line items would silently vanish at insert time.
  const skuProblems = useMemo(() => {
    const missing = new Map<string, string[]>();
    for (const o of parsed.orders) {
      for (const it of o.items) {
        if (!campaignSkus.has(it.sku)) {
          missing.set(it.sku, [...(missing.get(it.sku) || []), o.orderNumber]);
        }
      }
    }
    return missing;
  }, [parsed, campaignSkus]);

  // Upstream cancellations only apply when the pulled set is the active source.
  const cancellations = text.trim() === '' && pulledMapped ? pulledMapped.cancellations : [];
  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of parsed.orders) {
      const s = o.status || 'unknown';
      m.set(s, (m.get(s) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [parsed]);

  const canImport = enabled && (parsed.orders.length > 0 || cancellations.length > 0) && skuProblems.size === 0 && !importing;

  const runImport = async () => {
    if (!canImport || groupBuyId == null) return;
    setImporting(true);
    const out: RowState[] = [];
    for (const o of parsed.orders) {
      try {
        out.push(await importOne(o, groupBuyId));
      } catch (e: unknown) {
        out.push({ orderNumber: o.orderNumber, ok: false, message: e instanceof Error ? e.message : 'Import failed' });
      }
      setResults([...out]);
    }
    for (const c of cancellations) {
      try {
        const res = await doSyncStatus({ order_number: c.orderNumber, group_buy_id: groupBuyId, status: c.status }) as { id: number }[] | { id: number } | null;
        const touched = Array.isArray(res) ? res.length > 0 : !!res;
        out.push({
          orderNumber: c.orderNumber,
          ok: true,
          message: touched ? `marked ${c.status} (source: ${c.sourceStatus})` : `${c.sourceStatus} upstream — not present locally, nothing to do`,
        });
      } catch (e: unknown) {
        out.push({ orderNumber: c.orderNumber, ok: false, message: e instanceof Error ? e.message : `Failed to mark ${c.status}` });
      }
      setResults([...out]);
    }
    setImporting(false);
  };

  const importOne = async (o: ParsedOrder, gbId: number): Promise<RowState> => {
    // replaceOrderItems deletes before inserting, so an empty item set would
    // silently erase a previously imported order's items. Refuse it here for
    // every source (pull and paste).
    if (o.items.length === 0) {
      throw new Error('Order has no line items — refusing to import (would erase existing items)');
    }
    // Cash-rail totals include the payment-processor gross-up; make the fee explicit.
    const base = o.subtotal + o.tip + o.adminFee + o.shippingFee;
    const processorFee = o.paymentRail === 'cash' && o.total > base ? +(o.total - base).toFixed(2) : 0;

    const upserted = await doUpsert({
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
      processor_fee_usd: processorFee,
      total_usd: o.total,
      placed_at: o.placedAt || '',
      customer_note: o.customerNote || '',
      raw_import: JSON.stringify(o.raw),
    }) as { id: number }[] | { id: number };
    const orderId = Array.isArray(upserted) ? upserted[0]?.id : upserted?.id;
    if (!orderId) throw new Error('Refused: this order number already exists under a different campaign');

    // Items are written one row per product: UI Bakery's action layer rejects
    // multi-row inserts with repeated key columns, which is what silently
    // broke the old replaceOrderItems (and blocked payment sync behind it).
    // Duplicate SKU lines from the source are summed into one row first.
    // Summed in integer hundredths: quantities are 2-decimal values and the
    // write boundary rejects finer precision, so float addition (0.1 + 0.2 =
    // 0.30000000000000004) must never reach the qty param.
    const qtyBySku = new Map<string, number>();
    for (const it of o.items) qtyBySku.set(it.sku, (qtyBySku.get(it.sku) || 0) + Math.round(it.qty * 100));
    const mergedItems = [...qtyBySku.entries()].map(([sku, cents]) => ({ sku, qty: cents / 100 }));

    // Upsert every row FIRST and prove the whole replacement set is writable;
    // only then prune items removed upstream. A mid-loop failure leaves stale
    // extra items (a harmless superset, healed on re-run) — never a
    // destructively pruned partial state.
    let itemsWritten = 0;
    for (const it of mergedItems) {
      const res = await doUpsertItem({ order_id: orderId, group_buy_id: gbId, sku: it.sku, qty: it.qty }) as unknown[] | null;
      if (Array.isArray(res) ? res.length > 0 : !!res) itemsWritten++;
    }
    if (itemsWritten !== mergedItems.length) {
      throw new Error(`Only ${itemsWritten}/${mergedItems.length} items matched campaign products`);
    }
    await doPruneItems({ order_id: orderId, group_buy_id: gbId, items: JSON.stringify(mergedItems) });

    if (o.payments.length > 0) {
      const method = o.paymentRail === 'cash' ? 'other' : o.paymentRail;
      // Hashes go one per call (multi-row inserts trip the same platform
      // validation); receipts go together in one call because the action
      // clears pending receipts per invocation — per-receipt calls would
      // each wipe the previous one.
      const hashes = o.payments.filter(p => p.kind === 'tx_hash');
      const receipts = o.payments.filter(p => p.kind === 'receipt');
      for (const p of hashes) {
        await doPayments({ order_id: orderId, payments: JSON.stringify([{ kind: p.kind, value: p.value, method }]) });
      }
      if (receipts.length > 0) {
        await doPayments({ order_id: orderId, payments: JSON.stringify(receipts.map(p => ({ kind: p.kind, value: p.value, method: 'other' }))) });
      }
    }

    return { orderNumber: o.orderNumber, ok: true, message: `${mergedItems.length} items, ${o.payments.length} payment refs` };
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ClipboardPaste className="h-6 w-6 text-violet-600" /> Import Orders
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Orders for <span className="font-medium">{groupBuy?.name}</span> pull straight from the ordering app;
          the paste box below stays as a fallback. Re-importing the same orders is safe — they update in place, they don't duplicate.
        </p>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Button size="sm" onClick={pull} disabled={!canPull || pulling}>
              <CloudDownload className="w-4 h-4 mr-1" />
              {pulling ? 'Pulling…' : 'Pull from ordering app'}
            </Button>
            {!canPull && (
              <p className="text-sm text-muted-foreground">
                Needs the ordering-app JWT (Settings) and a linked campaign (Products → Ordering app).
              </p>
            )}
            {pulledMapped && text.trim() === '' && !pulling && (
              <p className="text-sm text-muted-foreground">
                {pulledMapped.orders.length} orders pulled from the ordering app
                {pulledMapped.cancellations.length > 0 ? `, ${pulledMapped.cancellations.length} upstream cancellation(s)` : ''}
                {pulledMapped.errors.length > 0 ? `, ${pulledMapped.errors.length} skipped` : ''}.
                {statusCounts.length > 0 && (
                  <span className="block text-xs mt-0.5">
                    Source statuses: {statusCounts.map(([s, n]) => `${s}: ${n}`).join(', ')}
                  </span>
                )}
              </p>
            )}
          </div>
          {pullError && <p className="text-sm text-red-600">{pullError}</p>}
        </CardContent>
      </Card>

      <Textarea
        placeholder="Or paste order rows here (overrides the pulled set while non-empty)…"
        value={text}
        onChange={e => { setText(e.target.value); setResults([]); }}
        rows={6}
        className="font-mono text-xs"
      />

      {(text.trim() !== '' || pulledMapped) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Preview — {parsed.orders.length} orders parsed
              {parsed.errors.length > 0 && <span className="text-red-600">, {parsed.errors.length} rows rejected</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {parsed.errors.length > 0 && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800 space-y-1">
                {parsed.errors.map((e, i) => (
                  <div key={i}><span className="font-mono">line {e.line}</span>: {e.reason} — <span className="font-mono text-xs">{e.text}</span></div>
                ))}
              </div>
            )}
            {cancellations.length > 0 && (
              <div className="rounded border border-orange-300 bg-orange-50 p-2 text-sm text-orange-900 space-y-1">
                <p className="font-semibold">Cancelled/refunded upstream — importing will update their local status (views already exclude them from demand and revenue):</p>
                {cancellations.map(c => {
                  const res = results.find(r => r.orderNumber === c.orderNumber);
                  return (
                    <div key={c.orderNumber}>
                      <span className="font-mono">{c.orderNumber}</span> → {c.status} <span className="text-xs">({c.sourceStatus})</span>
                      {res && <span className={`text-xs ml-2 ${res.ok ? 'text-green-700' : 'text-red-600'}`}>{res.message}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {skuProblems.size > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                <p className="font-semibold">Unknown SKUs — add these as campaign products first (Products page):</p>
                {[...skuProblems.entries()].map(([sku, ords]) => (
                  <div key={sku}><span className="font-mono">{sku}</span> — in {ords.length} order(s): {ords.slice(0, 5).join(', ')}{ords.length > 5 ? '…' : ''}</div>
                ))}
              </div>
            )}
            <div className="border rounded overflow-x-auto max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Rail</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Tx refs</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed.orders.map(o => {
                    const res = results.find(r => r.orderNumber === o.orderNumber);
                    return (
                      <TableRow key={o.orderNumber}>
                        <TableCell className="font-medium">{o.orderNumber}</TableCell>
                        <TableCell>{o.customerName}</TableCell>
                        <TableCell>{o.paymentRail}</TableCell>
                        <TableCell className="text-xs max-w-[220px] truncate">
                          {o.items.map(i => `${i.sku} (${i.qty})`).join('; ')}
                        </TableCell>
                        <TableCell className="text-right">{fmtUSD(o.total)}</TableCell>
                        <TableCell className="text-center">{o.payments.length}</TableCell>
                        <TableCell>
                          {res && (res.ok
                            ? <span className="text-green-700 text-xs flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />{res.message}</span>
                            : <span className="text-red-600 text-xs flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />{res.message}</span>)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Button onClick={runImport} disabled={!canImport}>
              {importing
                ? `Importing… (${results.length}/${parsed.orders.length + cancellations.length})`
                : `Import ${parsed.orders.length} orders${cancellations.length > 0 ? ` + apply ${cancellations.length} cancellation(s)` : ''}`}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
