import React, { useEffect, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getOrder from '@/actions/orders/getOrder';
import getOrderItems from '@/actions/orders/getOrderItems';
import listOrderPayments from '@/actions/payments/listOrderPayments';
import updateOrderAdmin from '@/actions/orders/updateOrderAdmin';
import addOverride from '@/actions/payments/addOverride';
import updatePaymentStatus from '@/actions/payments/updatePaymentStatus';
import addPaymentHash from '@/actions/payments/addPaymentHash';
import getOrderTxRefs from '@/actions/payments/getOrderTxRefs';
import { B44_DEFAULT_APP_ID, getB44Order, updateB44Order } from '@/lib/base44';
import { normalizeTxHash, canonicalTxRef } from '@/lib/parseOrderImport';
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
import { TxHash } from '@/components/TxHash';

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
  const { userName, settings } = useApp();
  const open = orderId != null;
  const [rawOrder, , , reloadOrder] = useLoadAction(getOrder, [orderId], { order_id: orderId }, { enabled: open });
  const [rawItems] = useLoadAction(getOrderItems, [orderId], { order_id: orderId }, { enabled: open });
  const [rawPayments, , , reloadPayments] = useLoadAction(listOrderPayments, [orderId], { order_id: orderId }, { enabled: open });
  const o = firstRow<OrderRow>(rawOrder);
  const items = rows<ItemRow>(rawItems);
  const payments = rows<PaymentRow>(rawPayments);

  const [doUpdate] = useMutateAction(updateOrderAdmin);
  const [doOverride] = useMutateAction(addOverride);
  const [doPayStatus] = useMutateAction(updatePaymentStatus);
  const [doAddHash] = useMutateAction(addPaymentHash);
  const [doGetTxRefs] = useMutateAction(getOrderTxRefs);

  const [status, setStatus] = useState('imported');
  const [hold, setHold] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const [overrideAmt, setOverrideAmt] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // payment corrections
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [newHash, setNewHash] = useState('');
  const [newHashMethod, setNewHashMethod] = useState('eth');
  const [payMsg, setPayMsg] = useState('');
  const [pushMsg, setPushMsg] = useState('');
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    if (o) {
      setStatus(o.status);
      setHold(!!o.hold_shipping);
      setAdminNote(o.admin_note || '');
      setOverrideAmt('');
      setOverrideReason('');
      setError('');
      setRejectingId(null); setRejectReason('');
      setNewHash(''); setPayMsg(''); setPushMsg('');
      setNewHashMethod(o.payment_rail === 'sol' || o.payment_rail === 'base' ? o.payment_rail : 'eth');
    }
  }, [o?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const rejectPayment = async (p: PaymentRow) => {
    if (!rejectReason.trim()) { setPayMsg('A reason is required — rejections are audited.'); return; }
    setSaving(true); setPayMsg('');
    try {
      await doPayStatus({
        payment_id: p.id, status: 'rejected', amount_usd: 0,
        notes: rejectReason.trim(), actor: userName,
      });
      setRejectingId(null); setRejectReason('');
      reloadPayments(); reloadOrder();
    } catch (e: unknown) {
      setPayMsg(e instanceof Error ? e.message : 'Failed to reject payment');
    } finally {
      setSaving(false);
    }
  };

  const addHash = async () => {
    if (!o) return;
    const h = normalizeTxHash(newHashMethod, newHash);
    if (!h) { setPayMsg(`That doesn't look like a valid ${newHashMethod.toUpperCase()} transaction hash (bare hash or explorer URL).`); return; }
    setSaving(true); setPayMsg('');
    try {
      const res = await doAddHash({ order_id: o.id, method: newHashMethod, tx_hash: h, actor: userName }) as { inserted: string }[] | { inserted: string };
      const inserted = Number(Array.isArray(res) ? res[0]?.inserted : res?.inserted);
      if (!inserted) { setPayMsg('That hash is already recorded (on this or another order).'); }
      else { setPayMsg('Added as pending — run Verify on the Reconciliation page to confirm it on-chain.'); setNewHash(''); }
      reloadPayments();
    } catch (e: unknown) {
      setPayMsg(e instanceof Error ? e.message : 'Failed to add hash');
    } finally {
      setSaving(false);
    }
  };

  const pushTxRefs = async () => {
    if (!o?.external_id) return;
    setPushing(true); setPushMsg('');
    try {
      const cfg = { appId: settings.base44_app_id || B44_DEFAULT_APP_ID, token: settings.base44_token || '' };
      // Read the local ref state from the DB at push time — never from this
      // render's payments array, which can lag a just-completed reject/add.
      const res = await doGetTxRefs({ order_id: o.id }) as { refs: string; rejected_refs: string }[] | { refs: string; rejected_refs: string };
      const row = Array.isArray(res) ? res[0] : res;
      const local = (row?.refs ?? '').split('|').map(s => s.trim()).filter(Boolean);
      // Canonical comparison (EVM hashes lowercase) so a checksum-cased copy
      // upstream still matches the locally stored form; SOL stays verbatim.
      const rejected = new Set((row?.rejected_refs ?? '').split('|').map(s => canonicalTxRef(s)).filter(Boolean));
      // Read-merge-write, not last-writer-wins: keep every upstream entry we
      // didn't explicitly reject (a ref added in the ordering app since the
      // last pull must survive this push), then append our refs not present.
      const remote = await getB44Order(cfg, o.external_id);
      const upstream = String(remote.transaction_hashtags || '').split('|').map(s => s.trim()).filter(Boolean);
      const kept = upstream.filter(u => !rejected.has(canonicalTxRef(u)));
      const keptSet = new Set(kept.map(canonicalTxRef));
      const merged = [...kept, ...local.filter(h => !keptSet.has(canonicalTxRef(h)))];
      await updateB44Order(cfg, o.external_id, { transaction_hashtags: merged.join(' | ') });
      setPushMsg(`Pushed ${merged.length} tx ref(s) to the ordering app (${rejected.size} rejected ref(s) removed).`);
    } catch (e: unknown) {
      setPushMsg(e instanceof Error ? e.message : 'Push failed');
    } finally {
      setPushing(false);
    }
  };

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
                  <div key={p.id} className={`py-1 border-b last:border-0 ${p.status === 'rejected' ? 'opacity-50' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusPill value={p.status} />
                          <span className="text-xs uppercase text-muted-foreground">{p.method}</span>
                        </div>
                        {p.tx_hash && <div><TxHash method={p.method} hash={p.tx_hash} /></div>}
                        {p.receipt_ref && <div className="text-xs text-muted-foreground">receipt: {p.receipt_ref}</div>}
                        {p.status === 'rejected' && p.notes && <div className="text-xs text-muted-foreground">rejected: {p.notes}</div>}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-right whitespace-nowrap">{Number(p.amount_usd) > 0 ? fmtUSD(p.amount_usd) : '—'}</span>
                        {p.status !== 'rejected' && rejectingId !== p.id && (
                          <Button size="sm" variant="ghost" className="h-6 text-xs text-red-600" onClick={() => { setRejectingId(p.id); setRejectReason(''); setPayMsg(''); }}>
                            Reject
                          </Button>
                        )}
                      </div>
                    </div>
                    {rejectingId === p.id && (
                      <div className="flex gap-2 mt-1">
                        <Input placeholder="Why is this payment wrong? (audited)" value={rejectReason} onChange={e => setRejectReason(e.target.value)} className="h-8 flex-1 text-xs" />
                        <Button size="sm" variant="destructive" className="h-8 text-xs" disabled={saving} onClick={() => rejectPayment(p)}>Confirm</Button>
                        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setRejectingId(null)}>Cancel</Button>
                      </div>
                    )}
                  </div>
                ))}

                <div className="flex gap-2 mt-2">
                  <Input placeholder="Add correct tx hash…" value={newHash} onChange={e => setNewHash(e.target.value)} className="h-8 flex-1 font-mono text-xs" />
                  <Select value={newHashMethod} onValueChange={setNewHashMethod}>
                    <SelectTrigger className="h-8 w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['eth', 'sol', 'base'].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-8 text-xs" disabled={saving} onClick={addHash}>Add</Button>
                </div>
                {payMsg && <p className="text-xs mt-1 text-muted-foreground">{payMsg}</p>}

                {o.external_id && (settings.base44_token || '') !== '' && (
                  <div className="mt-2 pt-2 border-t">
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={pushing} onClick={pushTxRefs}>
                        {pushing ? 'Pushing…' : 'Push tx refs to ordering app'}
                      </Button>
                      <span className="text-xs text-muted-foreground">replaces the order's hash list upstream with the non-rejected set</span>
                    </div>
                    {pushMsg && <p className="text-xs mt-1 text-muted-foreground">{pushMsg}</p>}
                  </div>
                )}
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
