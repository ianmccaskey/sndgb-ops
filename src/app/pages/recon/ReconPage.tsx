import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listOrderRecon from '@/actions/recon/listOrderRecon';
import listRailRecon from '@/actions/recon/listRailRecon';
import listPendingCryptoPayments from '@/actions/recon/listPendingCryptoPayments';
import recordChainVerification from '@/actions/payments/recordChainVerification';
import addManualPayment from '@/actions/payments/addManualPayment';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { getEvmTxTransfers } from '@/lib/moralis';
import { getSolTxTransfers } from '@/lib/helius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusPill } from '@/components/StatusPill';
import { Scale, Zap } from 'lucide-react';

type ReconRow = {
  order_id: number; order_number: string; customer_name: string; payment_rail: string | null;
  order_status: string; billed_usd: string; received_usd: string; override_usd: string | null;
  effective_received_usd: string; diff_usd: string; pending_payment_count: string; recon_status: string;
};
type RailRow = {
  payment_rail: string | null; order_count: string; billed_usd: string; received_usd: string;
  gap_usd: string; wallet_name: string | null; wallet_balance_usd: string | null; snapshot_at: string | null;
};
type PendingPayment = {
  payment_id: number; method: string; tx_hash: string; order_id: number;
  order_number: string; total_usd: string; customer_name: string;
};

/**
 * Verify one pending crypto payment against the chain. Stablecoin transfers
 * to the receiving wallet count at face value; native ETH/SOL counts only
 * when a wallet address is configured and is recorded with its token amount
 * for drift tracking (USD value must then be entered via override/manual).
 */
async function lookupPayment(
  p: PendingPayment,
  settings: Record<string, string>,
): Promise<{ amountUsd: number; nativeAmount: number | null; nativeSymbol: string | null; note: string }> {
  const method = p.method as 'eth' | 'sol' | 'base' | string;
  if (method === 'sol') {
    const key = settings.helius_api_key;
    if (!key) throw new Error('Set the Helius API key in Settings first.');
    const wallet = (settings.sol_wallet_address || '').trim();
    const transfers = await getSolTxTransfers(key, p.tx_hash);
    const toUs = wallet ? transfers.filter(t => t.to === wallet) : transfers;
    const stable = toUs.filter(t => t.token === 'USDC' || t.token === 'USDT').reduce((s, t) => s + t.amount, 0);
    const native = toUs.filter(t => t.token === 'SOL').reduce((s, t) => s + t.amount, 0);
    if (stable === 0 && native === 0) throw new Error(wallet ? 'No transfer to the configured SOL wallet found in this tx.' : 'No stablecoin transfer found in this tx.');
    return {
      amountUsd: stable,
      nativeAmount: native > 0 ? native : null,
      nativeSymbol: native > 0 ? 'SOL' : null,
      note: wallet ? '' : 'No SOL wallet configured — amount not recipient-checked.',
    };
  }
  if (method === 'eth' || method === 'base') {
    const key = settings.moralis_api_key;
    if (!key) throw new Error('Set the Moralis API key in Settings first.');
    const walletKey = method === 'base' ? 'base_wallet_address' : 'eth_wallet_address';
    const wallet = (settings[walletKey] || '').trim().toLowerCase();
    const transfers = await getEvmTxTransfers(key, method, p.tx_hash);
    const toUs = wallet ? transfers.filter(t => t.to === wallet) : transfers;
    const stable = toUs.filter(t => t.token === 'USDC' || t.token === 'USDT').reduce((s, t) => s + t.amount, 0);
    const native = toUs.filter(t => t.token === 'ETH').reduce((s, t) => s + t.amount, 0);
    if (stable === 0 && native === 0) throw new Error(wallet ? 'No transfer to the configured wallet found in this tx.' : 'No stablecoin transfer found in this tx.');
    return {
      amountUsd: stable,
      nativeAmount: native > 0 ? native : null,
      nativeSymbol: native > 0 ? 'ETH' : null,
      note: wallet ? '' : 'No wallet address configured — amount not recipient-checked.',
    };
  }
  throw new Error(`Cannot chain-verify a ${method} payment.`);
}

export function ReconPage() {
  const { groupBuyId, groupBuy, settings, userName } = useApp();
  const [filter, setFilter] = useState('all');
  const enabled = groupBuyId != null;

  const [rawRecon, , , reloadRecon] = useLoadAction(listOrderRecon, [groupBuyId, filter], { group_buy_id: groupBuyId, recon: filter }, { enabled });
  const [rawRails, , , reloadRails] = useLoadAction(listRailRecon, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawPending, , , reloadPending] = useLoadAction(listPendingCryptoPayments, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });

  const recon = rows<ReconRow>(rawRecon);
  const rails = rows<RailRow>(rawRails);
  const pending = rows<PendingPayment>(rawPending);

  const [doRecord] = useMutateAction(recordChainVerification);
  const [doManual] = useMutateAction(addManualPayment);

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
      const res = await lookupPayment(p, settings);
      const billed = parseFloat(p.total_usd);
      const tolerance = parseFloat(groupBuy?.reconcile_tolerance_usd || '1');
      // Native-token payments without a USD value stay pending-equivalent as
      // mismatch so someone prices them; stablecoin payments auto-resolve.
      const status = res.amountUsd > 0 && Math.abs(res.amountUsd - billed) <= tolerance ? 'verified'
        : res.amountUsd > 0 ? 'verified' // amount is real; order-level recon decides short/over
        : 'mismatch';
      await doRecord({
        payment_id: p.payment_id,
        amount_usd: res.amountUsd,
        native_amount: res.nativeAmount != null ? String(res.nativeAmount) : '',
        native_symbol: res.nativeSymbol || '',
        value_at_pay_usd: '',
        status,
        notes: res.note,
        actor: userName,
      });
      setVerifying(v => ({ ...v, [p.payment_id]: 'done' }));
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
    const orderRow = recon.find(r => r.order_number === mOrder.trim());
    if (!orderRow) { setMError('Order # not found in this campaign.'); return; }
    if (!(amt > 0)) { setMError('Amount must be positive.'); return; }
    setMSaving(true); setMError('');
    try {
      await doManual({
        order_id: orderRow.order_id, method: mMethod, tx_hash: '', receipt_ref: mRef,
        amount_usd: amt, notes: '', actor: userName,
      });
      setMOrder(''); setMAmount(''); setMRef('');
      reloadAll();
    } catch (e: unknown) {
      setMError(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setMSaving(false);
    }
  };

  return (
    <div className="p-6 space-y-5">
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
                {r.wallet_name && (
                  <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t mt-1">
                    <span>{r.wallet_name} snapshot</span>
                    <span>{fmtUSD(r.wallet_balance_usd, { cents: false })} · {fmtDateTime(r.snapshot_at)}</span>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Per-order</TabsTrigger>
          <TabsTrigger value="pending">Pending crypto ({pending.length})</TabsTrigger>
          <TabsTrigger value="manual">Record P2P payment</TabsTrigger>
        </TabsList>

        <TabsContent value="orders" className="mt-4 space-y-3">
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
          <div className="border rounded-lg overflow-x-auto">
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
                  <TableRow key={r.order_id}>
                    <TableCell className="font-medium">{r.order_number}</TableCell>
                    <TableCell>{r.customer_name}</TableCell>
                    <TableCell>{r.payment_rail}</TableCell>
                    <TableCell className="text-right">{fmtUSD(r.billed_usd)}</TableCell>
                    <TableCell className="text-right">
                      {fmtUSD(r.effective_received_usd)}
                      {r.override_usd != null && <span className="text-violet-600 text-xs ml-1">(override)</span>}
                    </TableCell>
                    <TableCell className={`text-right ${r.recon_status === 'short' ? 'text-red-600' : r.recon_status === 'over' ? 'text-blue-600' : 'text-muted-foreground'}`}>
                      {fmtUSD(r.diff_usd)}
                    </TableCell>
                    <TableCell><StatusPill value={r.recon_status} /></TableCell>
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
                    <TableCell className="font-medium">{p.order_number}</TableCell>
                    <TableCell>{p.customer_name}</TableCell>
                    <TableCell className="uppercase">{p.method}</TableCell>
                    <TableCell className="font-mono text-xs max-w-[240px] truncate" title={p.tx_hash}>{p.tx_hash}</TableCell>
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
    </div>
  );
}
