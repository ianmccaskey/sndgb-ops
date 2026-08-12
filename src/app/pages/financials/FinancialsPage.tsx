import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getPnl from '@/actions/financials/getPnl';
import listExpenses from '@/actions/financials/listExpenses';
import addExpense from '@/actions/financials/addExpense';
import deleteExpense from '@/actions/financials/deleteExpense';
import listWallets from '@/actions/financials/listWallets';
import addWalletSnapshot from '@/actions/financials/addWalletSnapshot';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { getEvmBalances } from '@/lib/moralis';
import { getSolBalances } from '@/lib/helius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart3, RefreshCw } from 'lucide-react';

type Pnl = {
  product_revenue_usd: string; order_count: string; admin_fee_revenue_usd: string;
  shipping_fee_revenue_usd: string; tip_revenue_usd: string; total_revenue_usd: string;
  product_profit_usd: string; expenses_usd: string; label_costs_usd: string; net_profit_usd: string;
  comps_usd: string; writeoffs_usd: string;
  splits: { party: string; pct: string }[] | null;
};
type Expense = { id: number; category: string; description: string; unit_cost_usd: string; qty: string; total_usd: string };
type Wallet = {
  id: number; name: string; chain: string; address: string | null; active: boolean;
  latest_balance_usd: string | null; latest_native_balance: string | null;
  latest_snapshot_at: string | null; latest_source: string | null;
};

export function FinancialsPage() {
  const { groupBuyId, settings } = useApp();
  const enabled = groupBuyId != null;
  const [rawPnl, , , reloadPnl] = useLoadAction(getPnl, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawExpenses, , , reloadExpenses] = useLoadAction(listExpenses, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawWallets, , , reloadWallets] = useLoadAction(listWallets, [], {});

  const pnl = firstRow<Pnl>(rawPnl);
  const expenses = rows<Expense>(rawExpenses);
  const wallets = rows<Wallet>(rawWallets);

  const [doAddExpense] = useMutateAction(addExpense);
  const [doDelExpense] = useMutateAction(deleteExpense);
  const [doSnapshot] = useMutateAction(addWalletSnapshot);

  const [eCat, setECat] = useState('supplies');
  const [eDesc, setEDesc] = useState('');
  const [eCost, setECost] = useState('');
  const [eQty, setEQty] = useState('1');
  const [eError, setEError] = useState('');

  const [refreshing, setRefreshing] = useState<Record<number, string>>({});
  const [manualBalance, setManualBalance] = useState<Record<number, string>>({});

  const netProfit = parseFloat(pnl?.net_profit_usd || '0');

  const submitExpense = async () => {
    if (!eDesc.trim() || !(Number(eCost) >= 0) || !(Number(eQty) > 0)) {
      setEError('Description, cost, and positive qty required.');
      return;
    }
    setEError('');
    try {
      await doAddExpense({
        group_buy_id: groupBuyId, category: eCat, description: eDesc.trim(),
        unit_cost_usd: Number(eCost), qty: Number(eQty), incurred_on: '',
      });
      setEDesc(''); setECost(''); setEQty('1');
      reloadExpenses(); reloadPnl();
    } catch (err: unknown) {
      setEError(err instanceof Error ? err.message : 'Failed to add expense');
    }
  };

  const refreshWallet = async (w: Wallet) => {
    setRefreshing(r => ({ ...r, [w.id]: 'fetching…' }));
    try {
      if (!w.address) throw new Error('No address configured (Settings).');
      let usd = 0; let native = 0;
      if (w.chain === 'sol') {
        const key = settings.helius_api_key;
        if (!key) throw new Error('Helius key missing (Settings).');
        const b = await getSolBalances(key, w.address);
        usd = b.usdc + b.usdt + b.pyusd; native = b.sol;
      } else if (w.chain === 'eth' || w.chain === 'base') {
        const key = settings.moralis_api_key;
        if (!key) throw new Error('Moralis key missing (Settings).');
        const b = await getEvmBalances(key, w.chain as 'eth' | 'base', w.address);
        usd = b.usdc + b.usdt + b.pyusd; native = b.native;
      } else {
        throw new Error('Fiat wallets are manual — type a balance instead.');
      }
      await doSnapshot({ wallet_id: w.id, balance_usd: usd, native_balance: String(native), source: 'auto' });
      setRefreshing(r => ({ ...r, [w.id]: '' }));
      reloadWallets();
    } catch (e: unknown) {
      setRefreshing(r => ({ ...r, [w.id]: e instanceof Error ? e.message : 'failed' }));
    }
  };

  const saveManualBalance = async (w: Wallet) => {
    const v = Number(manualBalance[w.id]);
    if (!(v >= 0)) return;
    await doSnapshot({ wallet_id: w.id, balance_usd: v, native_balance: '', source: 'manual' });
    setManualBalance(m => ({ ...m, [w.id]: '' }));
    reloadWallets();
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <BarChart3 className="h-6 w-6 text-violet-600" /> Financials
        </h1>
        <p className="text-sm text-muted-foreground mt-1">P&L is computed live from orders, products, expenses, and shipments — nothing is typed twice.</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Profit & Loss</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Product revenue (expected)</span><span>{fmtUSD(pnl?.product_revenue_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Admin fees ({pnl?.order_count || 0} orders)</span><span>{fmtUSD(pnl?.admin_fee_revenue_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Shipping fees</span><span>{fmtUSD(pnl?.shipping_fee_revenue_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Tips</span><span>{fmtUSD(pnl?.tip_revenue_usd)}</span></div>
            {Number(pnl?.comps_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Comped product (free to customers)</span><span className="text-red-600">−{fmtUSD(pnl?.comps_usd)}</span></div>
            )}
            {Number(pnl?.writeoffs_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Write-offs (forgiven shortfalls)</span><span className="text-red-600">−{fmtUSD(pnl?.writeoffs_usd)}</span></div>
            )}
            <div className="flex justify-between font-medium border-t pt-1"><span>Total revenue</span><span>{fmtUSD(pnl?.total_revenue_usd)}</span></div>
            <div className="flex justify-between mt-2"><span className="text-muted-foreground">Product profit</span><span>{fmtUSD(pnl?.product_profit_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Expenses (supplies, shipping, testing…)</span><span className="text-red-600">−{fmtUSD(pnl?.expenses_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Label costs (from shipments)</span><span className="text-red-600">−{fmtUSD(pnl?.label_costs_usd)}</span></div>
            <div className="flex justify-between font-semibold text-base border-t pt-1">
              <span>Net profit</span><span className={netProfit >= 0 ? 'text-green-700' : 'text-red-600'}>{fmtUSD(netProfit)}</span>
            </div>
            {(pnl?.splits || []).map(s => (
              <div key={s.party} className="flex justify-between text-muted-foreground">
                <span>{s.party} ({Number(s.pct)}%)</span>
                <span>{fmtUSD(netProfit * Number(s.pct) / 100)}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Wallets</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {wallets.map(w => (
              <div key={w.id} className="flex items-center justify-between gap-2 border-b last:border-0 pb-2">
                <div className="min-w-0">
                  <div className="font-medium text-sm">{w.name} <span className="text-xs text-muted-foreground uppercase">({w.chain})</span></div>
                  <div className="text-xs text-muted-foreground">
                    {w.latest_snapshot_at
                      ? <>{fmtUSD(w.latest_balance_usd)} stable{w.latest_native_balance ? ` + ${Number(w.latest_native_balance).toFixed(4)} native` : ''} · {fmtDateTime(w.latest_snapshot_at)} ({w.latest_source})</>
                      : 'No snapshot yet'}
                  </div>
                  {refreshing[w.id] && refreshing[w.id] !== 'fetching…' && <div className="text-xs text-red-600">{refreshing[w.id]}</div>}
                </div>
                {w.chain === 'fiat' ? (
                  <div className="flex gap-1">
                    <Input placeholder="Balance $" value={manualBalance[w.id] || ''} onChange={e => setManualBalance(m => ({ ...m, [w.id]: e.target.value }))} className="h-8 w-28" />
                    <Button size="sm" variant="outline" className="h-8" onClick={() => saveManualBalance(w)}>Set</Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" className="h-8" onClick={() => refreshWallet(w)} disabled={refreshing[w.id] === 'fetching…'}>
                    <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshing[w.id] === 'fetching…' ? 'animate-spin' : ''}`} /> Refresh
                  </Button>
                )}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">Wallet addresses and API keys live in Settings.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Expenses</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Select value={eCat} onValueChange={setECat}>
              <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['supplies', 'shipping', 'reship', 'testing', 'other'].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input placeholder="Description (e.g. 6x4x4 boxes)" value={eDesc} onChange={e => setEDesc(e.target.value)} className="h-9 flex-1 min-w-48" />
            <Input placeholder="Unit cost $" value={eCost} onChange={e => setECost(e.target.value)} className="h-9 w-28" />
            <Input placeholder="Qty" value={eQty} onChange={e => setEQty(e.target.value)} className="h-9 w-20" />
            <Button size="sm" onClick={submitExpense}>Add</Button>
          </div>
          {eError && <p className="text-sm text-red-600">{eError}</p>}
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Unit</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {expenses.map(e => (
                <TableRow key={e.id}>
                  <TableCell>{e.category}</TableCell>
                  <TableCell>{e.description}</TableCell>
                  <TableCell className="text-right">{fmtUSD(e.unit_cost_usd)}</TableCell>
                  <TableCell className="text-right">{Number(e.qty)}</TableCell>
                  <TableCell className="text-right font-medium">{fmtUSD(e.total_usd)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600"
                      onClick={() => doDelExpense({ id: e.id }).then(() => { reloadExpenses(); reloadPnl(); })}>
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {expenses.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No expenses recorded — they subtract from P&L the moment they're added.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
