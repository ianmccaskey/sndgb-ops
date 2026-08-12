import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listOrderRecon from '@/actions/recon/listOrderRecon';
import listRailRecon from '@/actions/recon/listRailRecon';
import listPendingCryptoPayments from '@/actions/recon/listPendingCryptoPayments';
import recordChainVerification from '@/actions/payments/recordChainVerification';
import addManualPaymentByNumber from '@/actions/payments/addManualPaymentByNumber';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { lookupTxPayment } from '@/lib/verifyPayment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusPill } from '@/components/StatusPill';
import { TxHash } from '@/components/TxHash';
import { OrderDetailSheet } from '@/app/pages/orders/OrderDetailSheet';
import { Scale, Zap } from 'lucide-react';

type ReconRow = {
  order_id: number; order_number: string; customer_name: string; payment_rail: string | null;
  order_status: string; billed_usd: string; comp_usd: string; writeoff_usd: string; due_usd: string; received_usd: string; override_usd: string | null;
  effective_received_usd: string; diff_usd: string; pending_payment_count: string; recon_status: string;
  native_unpriced: string | null;
};
type RailRow = {
  payment_rail: string | null; order_count: string; billed_usd: string; received_usd: string;
  gap_usd: string; wallet_name: string | null; wallet_balance_usd: string | null; snapshot_at: string | null;
  vendor_paid_usd: string; vendor_paid_asof_usd: string; wallet_count: string | null;
};
type PendingPayment = {
  payment_id: number; method: string; tx_hash: string; order_id: number;
  order_number: string; total_usd: string; customer_name: string;
};

export function ReconPage() {
  const { groupBuyId, groupBuy, settings, userName } = useApp();
  const [filter, setFilter] = useState('all');
  const [railFilter, setRailFilter] = useState('all');
  const [openOrderId, setOpenOrderId] = useState<number | null>(null);
  const enabled = groupBuyId != null;

  const [rawRecon, , , reloadRecon] = useLoadAction(listOrderRecon, [groupBuyId, filter, railFilter], { group_buy_id: groupBuyId, recon: filter, rail: railFilter }, { enabled });
  const [rawRails, , , reloadRails] = useLoadAction(listRailRecon, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawPending, , , reloadPending] = useLoadAction(listPendingCryptoPayments, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });

  const recon = rows<ReconRow>(rawRecon);
  const rails = rows<RailRow>(rawRails);
  const pending = rows<PendingPayment>(rawPending);

  const [doRecord] = useMutateAction(recordChainVerification);
  const [doManual] = useMutateAction(addManualPaymentByNumber);

  const [verifying, setVerifying] = useState<Record<number, string>>({});
  const [bulkRunning, setBulkRunning] = useState(false);

  // manual payment form
  const [mOrder, setMOrder] = useState('');
  const [mMethod, setMMethod] = useState('zelle');
  const [mAmount, setMAmount] = useState('');
  const [mRef, setMRef] = useState('');
  const [mError, setMError] = useState('');
  const [mSaving, setMSaving] = useState(false);

  const reloadAll = () => { reloadRecon(); reloadRails(); reloadPending(); };

  const verifyOne = async (p: PendingPayment) => {
    setVerifying(v => ({ ...v, [p.payment_id]: 'checking…' }));
    try {
      const res = await lookupTxPayment(p.method, p.tx_hash, settings);
      const billed = parseFloat(p.total_usd);
      const tolerance = parseFloat(groupBuy?.reconcile_tolerance_usd || '1');
      // Native-token payments without a USD value stay pending-equivalent as
      // mismatch so someone prices them; stablecoin payments auto-resolve.
      const status = res.amountUsd > 0 && Math.abs(res.amountUsd - billed) <= tolerance ? 'verified'
        : res.amountUsd > 0 ? 'verified' // amount is real; order-level recon decides short/over
        : 'mismatch';
      const recorded = await doRecord({
        payment_id: p.payment_id,
        amount_usd: res.amountUsd,
        native_amount: res.nativeAmount != null ? String(res.nativeAmount) : '',
        native_symbol: res.nativeSymbol || '',
        value_at_pay_usd: '',
        status,
        notes: res.note,
        actor: userName,
      }) as unknown[] | null;
      // Zero rows = the payment stopped being pending mid-lookup (e.g. it was
      // rejected in the correction flow) — the stale result was NOT written.
      const wrote = Array.isArray(recorded) ? recorded.length > 0 : !!recorded;
      const nativeOnly = res.amountUsd === 0 && res.nativeAmount != null && res.nativeAmount > 0;
      setVerifying(v => ({
        ...v,
        [p.payment_id]: !wrote ? 'skipped — no longer pending'
          : nativeOnly ? `native ${res.nativeAmount} ${res.nativeSymbol} — needs USD pricing`
          : 'done',
      }));
    } catch (e: unknown) {
      setVerifying(v => ({ ...v, [p.payment_id]: e instanceof Error ? e.message : 'failed' }));
    }
  };

  const verifyAll = async () => {
    setBulkRunning(true);
    for (const p of pending) {
      await verifyOne(p);
    }
    setBulkRunning(false);
    reloadAll();
  };

  const addManual = async () => {
    const amt = Number(mAmount);
    if (!(amt > 0)) { setMError('Amount must be positive.'); return; }
    setMSaving(true); setMError('');
    try {
      // One atomic statement resolves the order (by campaign + number,
      // cancelled/refunded excluded) and inserts the payment — the recon
      // table's filters can't hide a valid order, and no lookup/insert race.
      const res = await doManual({
        group_buy_id: groupBuyId, order_number: mOrder, method: mMethod, tx_hash: '', receipt_ref: mRef,
        amount_usd: amt, notes: '', actor: userName,
      }) as { inserted: string }[] | { inserted: string };
      const inserted = Number(Array.isArray(res) ? res[0]?.inserted : res?.inserted);
      if (!inserted) { setMError('Order # not found in this campaign (or it is cancelled/refunded).'); setMSaving(false); return; }
      setMOrder(''); setMAmount(''); setMRef('');
      reloadAll();
    } catch (e: unknown) {
      setMError(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setMSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Scale className="h-6 w-6 text-violet-600" /> Payments & Reconciliation
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Billed vs received per order and per rail · tolerance ±{fmtUSD(groupBuy?.reconcile_tolerance_usd || 1)}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rails.map(r => {
          const gap = parseFloat(r.gap_usd || '0');
          return (
            <Card key={r.payment_rail || 'none'}>
              <CardHeader className="pb-1">
                <CardTitle className="text-sm uppercase">{r.payment_rail || '—'} <span className="text-muted-foreground font-normal">· {r.order_count} orders</span></CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-0.5">
                <div className="flex justify-between"><span className="text-muted-foreground">Billed</span><span>{fmtUSD(r.billed_usd, { cents: false })}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Received</span><span>{fmtUSD(r.received_usd, { cents: false })}</span></div>
                <div className={`flex justify-between font-semibold ${Math.abs(gap) > 1 ? 'text-red-600' : 'text-green-700'}`}>
                  <span>Gap</span><span>{fmtUSD(gap, { cents: false })}</span>
                </div>
                {Number(r.vendor_paid_usd) > 0 && (
                  <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t mt-1">
                    <span>Paid to vendors (from this wallet)</span>
                    <span>−{fmtUSD(r.vendor_paid_usd, { cents: false })}</span>
                  </div>
                )}
                {r.wallet_name && (() => {
                  // Expected ≈ customer money received on this rail minus the
                  // payouts already reflected in the snapshot (dated at or
                  // before it) — so a post-payout snapshot reads as
                  // accounted-for, and a payout newer than the snapshot
                  // doesn't fabricate drift.
                  const expected = parseFloat(r.received_usd || '0') - parseFloat(r.vendor_paid_asof_usd || '0');
                  const snapshot = r.wallet_balance_usd != null ? parseFloat(r.wallet_balance_usd) : null;
                  const drift = snapshot != null ? snapshot - expected : null;
                  return (
                    <div className={`text-xs text-muted-foreground ${Number(r.vendor_paid_usd) > 0 ? '' : 'pt-1 border-t mt-1'} space-y-0.5`}>
                      <div className="flex justify-between">
                        <span>{r.wallet_name} snapshot</span>
                        <span>{fmtUSD(r.wallet_balance_usd, { cents: false })} · {fmtDateTime(r.snapshot_at)}</span>
                      </div>
                      {Number(r.vendor_paid_usd) > 0 && drift != null && Number(r.wallet_count) === 1 && (
                        <div
                          className="flex justify-between"
                          title="Approximation assuming this wallet is dedicated to this campaign — an opening balance or unrelated transfers land in the drift figure. The drift is a pointer to investigate, not a reconciliation verdict."
                        >
                          <span>≈ Expected if dedicated (received − payouts)</span>
                          <span>
                            {fmtUSD(expected, { cents: false })}
                            <span className={Math.abs(drift) <= 50 ? 'text-green-700' : 'text-amber-600'}>
                              {' '}({drift >= 0 ? '+' : '−'}{fmtUSD(Math.abs(drift), { cents: false })})
                            </span>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Tabs defaultValue="orders">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="orders">Per-order</TabsTrigger>
          <TabsTrigger value="pending">Pending crypto ({pending.length})</TabsTrigger>
          <TabsTrigger value="manual">Record P2P payment</TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2">
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="short">short</SelectItem>
                <SelectItem value="over">over</SelectItem>
                <SelectItem value="awaiting">awaiting</SelectItem>
                <SelectItem value="matched">matched</SelectItem>
              </SelectContent>
            </Select>
            <Select value={railFilter} onValueChange={setRailFilter}>
              <SelectTrigger className="h-8 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All payment rails</SelectItem>
                <SelectItem value="crypto">Crypto (all chains)</SelectItem>
                <SelectItem value="cash">Cash / P2P</SelectItem>
                <SelectItem value="eth">Ethereum</SelectItem>
                <SelectItem value="sol">Solana</SelectItem>
                <SelectItem value="base">Base</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {/* Phones: two-row entries — order # with billed → received on top,
              customer with diff, rail, status, and native flag below. */}
          <div className="md:hidden border rounded-lg divide-y">
            {recon.length === 0 && (
              <p className="text-center text-muted-foreground py-6 text-sm">Nothing here.</p>
            )}
            {recon.map(r => {
              const diff = parseFloat(r.diff_usd || '0');
              return (
                <button
                  key={r.order_id}
                  type="button"
                  onClick={() => setOpenOrderId(r.order_id)}
                  className="w-full text-left px-3 py-2.5 active:bg-muted/60"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium whitespace-nowrap">{r.order_number}</span>
                    <span className="text-sm whitespace-nowrap">
                      {fmtUSD(r.billed_usd)} <span className="text-muted-foreground">→</span> {fmtUSD(r.effective_received_usd)}
                      {r.override_usd != null && <span className="text-violet-600 text-xs ml-1">(override)</span>}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-sm text-muted-foreground truncate">{r.customer_name}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {Math.abs(diff) > 0.005 && (
                        <span className={`text-xs font-medium ${r.recon_status === 'short' ? 'text-red-600' : r.recon_status === 'over' ? 'text-blue-600' : 'text-muted-foreground'}`}>
                          {fmtUSD(diff)}
                        </span>
                      )}
                      <span className="text-xs uppercase text-muted-foreground">{r.payment_rail || '—'}</span>
                      <StatusPill value={r.recon_status} />
                      {Number(r.comp_usd) > 0 && (
                        <span className="rounded bg-green-100 text-green-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase">
                          comp −{fmtUSD(r.comp_usd)}
                        </span>
                      )}
                      {Number(r.writeoff_usd) > 0 && (
                        <span className="rounded bg-green-100 text-green-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase">
                          w/o −{fmtUSD(r.writeoff_usd)}
                        </span>
                      )}
                      {r.native_unpriced && (
                        <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase">
                          native {r.native_unpriced}
                        </span>
                      )}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Tablets and up: the full table. */}
          <div className="hidden md:block border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Rail</TableHead>
                  <TableHead className="text-right">Billed</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Diff</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recon.map(r => (
                  <TableRow key={r.order_id} onClick={() => setOpenOrderId(r.order_id)} className="cursor-pointer hover:bg-muted/50">
                    <TableCell className="font-medium">{r.order_number}</TableCell>
                    <TableCell>{r.customer_name}</TableCell>
                    <TableCell>{r.payment_rail}</TableCell>
                    <TableCell className="text-right">
                      {fmtUSD(r.billed_usd)}
                      {(Number(r.comp_usd) > 0 || Number(r.writeoff_usd) > 0) && (
                        <span className="block text-[11px] text-green-700" title="Comped items and write-offs — the customer owes billed minus these">
                          {Number(r.comp_usd) > 0 ? `−${fmtUSD(r.comp_usd)} comp ` : ''}{Number(r.writeoff_usd) > 0 ? `−${fmtUSD(r.writeoff_usd)} w/o ` : ''}→ {fmtUSD(r.due_usd)} due
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {fmtUSD(r.effective_received_usd)}
                      {r.override_usd != null && <span className="text-violet-600 text-xs ml-1">(override)</span>}
                    </TableCell>
                    <TableCell className={`text-right ${r.recon_status === 'short' ? 'text-red-600' : r.recon_status === 'over' ? 'text-blue-600' : 'text-muted-foreground'}`}>
                      {fmtUSD(r.diff_usd)}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1">
                        <StatusPill value={r.recon_status} />
                        {r.native_unpriced && (
                          <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title={`Customer paid in native ${r.native_unpriced} — coin amount recorded, needs pricing. Open the order and set an override for the TOTAL received USD (override replaces the verified sum).`}>
                            native {r.native_unpriced}
                          </span>
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
                {recon.length === 0 && (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">Nothing here.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="pending" className="mt-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Each row is a tx hash imported with an order that hasn't been checked on-chain yet.
            </p>
            <Button size="sm" onClick={verifyAll} disabled={bulkRunning || pending.length === 0}>
              <Zap className="w-4 h-4 mr-1" /> {bulkRunning ? 'Verifying…' : `Verify all (${pending.length})`}
            </Button>
          </div>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Chain</TableHead>
                  <TableHead>Tx hash</TableHead>
                  <TableHead className="text-right">Order total</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pending.map(p => (
                  <TableRow key={p.payment_id}>
                    <TableCell className="font-medium">
                      <button type="button" className="text-violet-600 hover:underline" onClick={e => { e.stopPropagation(); setOpenOrderId(p.order_id); }}>
                        {p.order_number}
                      </button>
                    </TableCell>
                    <TableCell>{p.customer_name}</TableCell>
                    <TableCell className="uppercase">{p.method}</TableCell>
                    <TableCell><TxHash method={p.method} hash={p.tx_hash} /></TableCell>
                    <TableCell className="text-right">{fmtUSD(p.total_usd)}</TableCell>
                    <TableCell>
                      {verifying[p.payment_id] && verifying[p.payment_id] !== 'done'
                        ? <span className="text-xs text-muted-foreground">{verifying[p.payment_id]}</span>
                        : verifying[p.payment_id] === 'done'
                          ? <span className="text-xs text-green-700">verified ✓</span>
                          : <Button size="sm" variant="outline" onClick={() => verifyOne(p).then(reloadAll)}>Verify</Button>}
                    </TableCell>
                  </TableRow>
                ))}
                {pending.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No pending crypto payments.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="manual" className="mt-4">
          <Card className="max-w-lg">
            <CardHeader className="pb-2"><CardTitle className="text-base">Record a Zelle / Venmo / PayPal / cash payment</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-2">
                <Input placeholder="Order # (e.g. 2026-042)" value={mOrder} onChange={e => setMOrder(e.target.value)} className="h-9 flex-1" />
                <Select value={mMethod} onValueChange={setMMethod}>
                  <SelectTrigger className="h-9 w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['zelle', 'venmo', 'paypal', 'cash', 'other'].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Input placeholder="Amount USD" value={mAmount} onChange={e => setMAmount(e.target.value)} className="h-9 w-36" />
                <Input placeholder="Receipt / confirmation # (optional)" value={mRef} onChange={e => setMRef(e.target.value)} className="h-9 flex-1" />
              </div>
              {mError && <p className="text-sm text-red-600">{mError}</p>}
              <Button size="sm" onClick={addManual} disabled={mSaving}>Record payment</Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <OrderDetailSheet orderId={openOrderId} onClose={() => { setOpenOrderId(null); reloadAll(); }} />
    </div>
  );
}
