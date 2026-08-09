import React, { useMemo, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import importUpsertOrder from '@/actions/orders/importUpsertOrder';
import replaceOrderItems from '@/actions/orders/replaceOrderItems';
import importPayments from '@/actions/orders/importPayments';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD } from '@/lib/fmt';
import { parseOrderPaste, ParsedOrder } from '@/lib/parseOrderImport';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ClipboardPaste, CheckCircle2, XCircle } from 'lucide-react';

type CampaignProduct = { sku_code: string };

type RowState = { orderNumber: string; ok: boolean; message: string };

export function ImportPage() {
  const { groupBuyId, groupBuy } = useApp();
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [results, setResults] = useState<RowState[]>([]);

  const enabled = groupBuyId != null;
  const [rawProducts] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const campaignSkus = useMemo(
    () => new Set(rows<CampaignProduct>(rawProducts).map(p => p.sku_code)),
    [rawProducts],
  );

  const [doUpsert] = useMutateAction(importUpsertOrder);
  const [doItems] = useMutateAction(replaceOrderItems);
  const [doPayments] = useMutateAction(importPayments);

  const parsed = useMemo(() => parseOrderPaste(text), [text]);

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

  const canImport = enabled && parsed.orders.length > 0 && skuProblems.size === 0 && !importing;

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
    setImporting(false);
  };

  const importOne = async (o: ParsedOrder, gbId: number): Promise<RowState> => {
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
    if (!orderId) throw new Error('Upsert returned no order id');

    const itemsRes = await doItems({
      order_id: orderId,
      group_buy_id: gbId,
      items: JSON.stringify(o.items),
    }) as { source_count: string; inserted_count: string }[] | { source_count: string; inserted_count: string };
    const ir = Array.isArray(itemsRes) ? itemsRes[0] : itemsRes;
    if (ir && Number(ir.inserted_count) !== Number(ir.source_count)) {
      throw new Error(`Only ${ir.inserted_count}/${ir.source_count} items matched campaign products`);
    }

    if (o.payments.length > 0) {
      const method = o.paymentRail === 'cash' ? 'other' : o.paymentRail;
      await doPayments({
        order_id: orderId,
        payments: JSON.stringify(o.payments.map(p => ({ kind: p.kind, value: p.value, method: p.kind === 'tx_hash' ? method : 'other' }))),
      });
    }

    return { orderNumber: o.orderNumber, ok: true, message: `${o.items.length} items, ${o.payments.length} payment refs` };
  };

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ClipboardPaste className="h-6 w-6 text-violet-600" /> Import Orders
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Paste rows from the ordering app export (tab-separated, header optional) into <span className="font-medium">{groupBuy?.name}</span>.
          Re-importing the same orders is safe — they update in place, they don't duplicate.
        </p>
      </div>

      <Textarea
        placeholder="Paste order rows here…"
        value={text}
        onChange={e => { setText(e.target.value); setResults([]); }}
        rows={8}
        className="font-mono text-xs"
      />

      {text.trim() !== '' && (
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
              {importing ? `Importing… (${results.length}/${parsed.orders.length})` : `Import ${parsed.orders.length} orders`}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
