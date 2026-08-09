import React, { useEffect, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getOrder from '@/actions/orders/getOrder';
import getOrderItems from '@/actions/orders/getOrderItems';
import listOrderPayments from '@/actions/payments/listOrderPayments';
import updateOrderAdmin from '@/actions/orders/updateOrderAdmin';
import addOverride from '@/actions/payments/addOverride';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { StatusPill } from '@/components/StatusPill';

type OrderRow = {
  id: number; order_number: string; external_id: string | null; status: string;
  payment_rail: string | null; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; discord_username: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null;
  state_code: string | null; postal_code: string | null;
  subtotal_usd: string; tip_usd: string; admin_fee_usd: string; shipping_fee_usd: string;
  processor_fee_usd: string; total_usd: string; placed_at: string | null;
  customer_note: string | null; admin_note: string | null; hold_shipping: boolean;
  customer_name: string; customer_email: string | null;
  recon_status: string | null; received_usd: string | null; override_usd: string | null;
  effective_received_usd: string | null; diff_usd: string | null;
};

type ItemRow = { id: number; qty: string; unit_price_usd: string; line_total_usd: string; sku_code: string; product_name: string };
type PaymentRow = {
  id: number; method: string; tx_hash: string | null; receipt_ref: string | null;
  amount_usd: string; status: string; verify_source: string | null; verified_at: string | null; notes: string | null;
};

export function OrderDetailSheet({ orderId, onClose }: { orderId: number | null; onClose: () => void }) {
  const { userName } = useApp();
  const open = orderId != null;
  const [rawOrder, , , reloadOrder] = useLoadAction(getOrder, [orderId], { order_id: orderId }, { enabled: open });
  const [rawItems] = useLoadAction(getOrderItems, [orderId], { order_id: orderId }, { enabled: open });
  const [rawPayments] = useLoadAction(listOrderPayments, [orderId], { order_id: orderId }, { enabled: open });
  const o = firstRow<OrderRow>(rawOrder);
  const items = rows<ItemRow>(rawItems);
  const payments = rows<PaymentRow>(rawPayments);

  const [doUpdate] = useMutateAction(updateOrderAdmin);
  const [doOverride] = useMutateAction(addOverride);

  const [status, setStatus] = useState('imported');
  const [hold, setHold] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const [overrideAmt, setOverrideAmt] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (o) {
      setStatus(o.status);
      setHold(!!o.hold_shipping);
      setAdminNote(o.admin_note || '');
      setOverrideAmt('');
      setOverrideReason('');
      setError('');
    }
  }, [o?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!o) return;
    setSaving(true); setError('');
    try {
      await doUpdate({ order_id: o.id, status, hold_shipping: hold, admin_note: adminNote, actor: userName });
      reloadOrder();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const saveOverride = async () => {
    if (!o) return;
    const amt = Number(overrideAmt);
    if (!(amt >= 0) || !overrideReason.trim()) {
      setError('Override needs an amount and a reason — overrides are audited.');
      return;
    }
    setSaving(true); setError('');
    try {
      await doOverride({ order_id: o.id, amount_usd: amt, reason: overrideReason.trim(), created_by: userName });
      setOverrideAmt(''); setOverrideReason('');
      reloadOrder();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save override');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        {o && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {o.order_number} <StatusPill value={o.recon_status || 'awaiting'} />
              </SheetTitle>
            </SheetHeader>
            <div className="space-y-5 mt-4 text-sm">
              <div>
                <div className="font-medium">{o.customer_name}</div>
                <div className="text-muted-foreground">{o.contact_email} {o.contact_phone ? `· ${o.contact_phone}` : ''} {o.discord_username ? `· ${o.discord_username}` : ''}</div>
                <div className="text-muted-foreground mt-1">
                  {o.address_line1}{o.address_line2 ? `, ${o.address_line2}` : ''}, {o.city}, {o.state_code} {o.postal_code}
                </div>
                <div className="text-xs text-muted-foreground mt-1">Placed {fmtDateTime(o.placed_at)} · rail: {o.payment_rail}</div>
              </div>

              {o.customer_note && (
                <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
                  <span className="text-xs font-semibold uppercase">Customer note</span>
                  <p className="mt-0.5 whitespace-pre-wrap">{o.customer_note}</p>
                </div>
              )}

              <div>
                <h3 className="font-semibold mb-1">Items</h3>
                {items.map(it => (
                  <div key={it.id} className="flex justify-between py-0.5">
                    <span>{it.sku_code} × {it.qty}</span>
                    <span>{fmtUSD(it.line_total_usd)}</span>
                  </div>
                ))}
                <Separator className="my-2" />
                <div className="space-y-0.5 text-muted-foreground">
                  <div className="flex justify-between"><span>Subtotal</span><span>{fmtUSD(o.subtotal_usd)}</span></div>
                  {Number(o.tip_usd) > 0 && <div className="flex justify-between"><span>Tip</span><span>{fmtUSD(o.tip_usd)}</span></div>}
                  <div className="flex justify-between"><span>Admin fee</span><span>{fmtUSD(o.admin_fee_usd)}</span></div>
                  <div className="flex justify-between"><span>Shipping fee</span><span>{fmtUSD(o.shipping_fee_usd)}</span></div>
                  {Number(o.processor_fee_usd) > 0 && <div className="flex justify-between"><span>Processor fee</span><span>{fmtUSD(o.processor_fee_usd)}</span></div>}
                  <div className="flex justify-between font-semibold text-foreground"><span>Total</span><span>{fmtUSD(o.total_usd)}</span></div>
                  <div className="flex justify-between"><span>Received (effective)</span><span>{fmtUSD(o.effective_received_usd)}</span></div>
                  {o.override_usd != null && <div className="flex justify-between text-violet-700"><span>Manual override active</span><span>{fmtUSD(o.override_usd)}</span></div>}
                </div>
              </div>

              <div>
                <h3 className="font-semibold mb-1">Payments</h3>
                {payments.length === 0 && <p className="text-muted-foreground">No payment records.</p>}
                {payments.map(p => (
                  <div key={p.id} className="flex items-center justify-between gap-2 py-1 border-b last:border-0">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <StatusPill value={p.status} />
                        <span className="text-xs uppercase text-muted-foreground">{p.method}</span>
                      </div>
                      {p.tx_hash && <div className="text-xs font-mono truncate max-w-[300px]" title={p.tx_hash}>{p.tx_hash}</div>}
                      {p.receipt_ref && <div className="text-xs text-muted-foreground">receipt: {p.receipt_ref}</div>}
                    </div>
                    <div className="text-right whitespace-nowrap">{Number(p.amount_usd) > 0 ? fmtUSD(p.amount_usd) : '—'}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-2">
                <h3 className="font-semibold">Admin</h3>
                <div className="flex items-center gap-3">
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['imported', 'verified', 'flagged', 'refunded', 'cancelled'].map(s => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <Switch checked={hold} onCheckedChange={setHold} id="hold" />
                    <Label htmlFor="hold" className="text-sm">Hold shipping</Label>
                  </div>
                </div>
                <Textarea placeholder="Admin note" value={adminNote} onChange={e => setAdminNote(e.target.value)} rows={2} />
                <Button size="sm" onClick={save} disabled={saving}>Save</Button>
              </div>

              <div className="space-y-2 rounded border p-3">
                <h3 className="font-semibold text-sm">Reconciliation override</h3>
                <p className="text-xs text-muted-foreground">
                  Forces the effective received amount for this order. Reason is required and the change is logged.
                </p>
                <div className="flex gap-2">
                  <Input placeholder="Amount USD" value={overrideAmt} onChange={e => setOverrideAmt(e.target.value)} className="h-8 w-32" />
                  <Input placeholder="Reason (required)" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} className="h-8 flex-1" />
                  <Button size="sm" variant="outline" onClick={saveOverride} disabled={saving}>Apply</Button>
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
