import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getPnl from '@/actions/financials/getPnl';
import listExpenses from '@/actions/financials/listExpenses';
import addExpense from '@/actions/financials/addExpense';
import deleteExpense from '@/actions/financials/deleteExpense';
import listWallets from '@/actions/financials/listWallets';
import addWalletSnapshot from '@/actions/financials/addWalletSnapshot';
import listNonCoaVendorOwed from '@/actions/vendors/listNonCoaVendorOwed';
import listFreightByVendor from '@/actions/financials/listFreightByVendor';
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
  shipping_fee_revenue_usd: string; insurance_revenue_usd: string; tip_revenue_usd: string; total_revenue_usd: string;
  product_profit_usd: string; expenses_usd: string; label_costs_usd: string; net_profit_usd: string;
  direct_freight_usd: string; split_fees_usd: string; at_cost_margin_usd: string;
  stock_cost_usd: string; stock_retail_usd: string;
  comps_usd: string; credits_usd: string; writeoffs_usd: string; adj_both_usd: string;
  adjustments: { beneficiary: string; value_usd: string; count: string }[] | null;
  splits: { party: string; pct: string }[] | null;
};
type Expense = { id: number; category: string; description: string; unit_cost_usd: string; qty: string; total_usd: string };
type Wallet = {
  id: number; name: string; chain: string; address: string | null; active: boolean;
  latest_balance_usd: string | null; latest_native_balance: string | null;
  latest_snapshot_at: string | null; latest_source: string | null;
};
type OwedRow = { vendor_code: string; demand_usd: string; paid_usd: string; owed_usd: string };
type CovBalance = { name: string; chain: string; usd: number };

export function FinancialsPage() {
  const { groupBuyId, settings } = useApp();
  const enabled = groupBuyId != null;
  const [rawPnl, , , reloadPnl] = useLoadAction(getPnl, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawFreight] = useLoadAction(listFreightByVendor, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawExpenses, , , reloadExpenses] = useLoadAction(listExpenses, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawWallets, , , reloadWallets] = useLoadAction(listWallets, [], {});

  const pnl = firstRow<Pnl>(rawPnl);
  const expenses = rows<Expense>(rawExpenses);
  const wallets = rows<Wallet>(rawWallets);
  const freightByVendor = rows<{ vendor_code: string; kit_freight_usd: string; direct_freight_usd: string; boxes: string; total_freight_usd: string }>(rawFreight);

  const [doAddExpense] = useMutateAction(addExpense);
  const [doDelExpense] = useMutateAction(deleteExpense);
  const [doSnapshot] = useMutateAction(addWalletSnapshot);
  const [fetchOwed] = useMutateAction(listNonCoaVendorOwed);

  const [eCat, setECat] = useState('supplies');
  const [eDesc, setEDesc] = useState('');
  const [eCost, setECost] = useState('');
  const [eQty, setEQty] = useState('1');
  const [eError, setEError] = useState('');

  const [refreshing, setRefreshing] = useState<Record<number, string>>({});
  const [manualBalance, setManualBalance] = useState<Record<number, string>>({});

  // wallet-coverage check: live ETH+SOL stablecoin holdings vs non-COA vendor
  // owed. Both sides are fetched in the SAME run and rendered only together,
  // so the verdict can never pair fresh balances with stale owed figures.
  const [covRunning, setCovRunning] = useState(false);
  const [covError, setCovError] = useState('');
  const [covBalances, setCovBalances] = useState<CovBalance[] | null>(null);
  const [covOwedRows, setCovOwedRows] = useState<OwedRow[] | null>(null);

  const owedRows = (covOwedRows || []).filter(v => Number(v.owed_usd) > 0);
  const covOwed = (covOwedRows || []).reduce((s, v) => s + Number(v.owed_usd), 0);
  const covHeld = (covBalances || []).reduce((s, b) => s + b.usd, 0);

  const runCoverage = async () => {
    setCovRunning(true); setCovError(''); setCovBalances(null); setCovOwedRows(null);
    try {
      const targets = wallets.filter(w => w.active && (w.chain === 'eth' || w.chain === 'sol') && w.address);
      if (targets.length === 0) throw new Error('No active ETH/SOL wallets with addresses (Settings).');
      const owed = rows<OwedRow>(await fetchOwed({}));
      const balances: CovBalance[] = [];
      // sequential on purpose — the same providers rate-limit bursts
      for (const w of targets) {
        if (w.chain === 'sol') {
          if (!settings.helius_api_key) throw new Error('Helius key missing (Settings).');
          const b = await getSolBalances(settings.helius_api_key, w.address!);
          balances.push({ name: w.name, chain: w.chain, usd: b.usdc + b.usdt + b.pyusd });
        } else {
          if (!settings.moralis_api_key) throw new Error('Moralis key missing (Settings).');
          const b = await getEvmBalances(settings.moralis_api_key, 'eth', w.address!);
          balances.push({ name: w.name, chain: w.chain, usd: b.usdc + b.usdt + b.pyusd });
        }
      }
      setCovOwedRows(owed);
      setCovBalances(balances);
    } catch (e: unknown) {
      setCovError(e instanceof Error ? e.message : 'Failed to fetch balances');
    } finally {
      setCovRunning(false);
    }
  };

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
            {Number(pnl?.insurance_revenue_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Shipping insurance</span><span>{fmtUSD(pnl?.insurance_revenue_usd)}</span></div>
            )}
            <div className="flex justify-between"><span className="text-muted-foreground">Tips</span><span>{fmtUSD(pnl?.tip_revenue_usd)}</span></div>
            {Number(pnl?.split_fees_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Split kit fees</span><span>{fmtUSD(pnl?.split_fees_usd)}</span></div>
            )}
            {Number(pnl?.comps_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Comped product (free to customers)</span><span className="text-red-600">−{fmtUSD(pnl?.comps_usd)}</span></div>
            )}
            {Number(pnl?.credits_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Customer credits</span><span className="text-red-600">−{fmtUSD(pnl?.credits_usd)}</span></div>
            )}
            {Number(pnl?.writeoffs_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Write-offs (forgiven shortfalls)</span><span className="text-red-600">−{fmtUSD(pnl?.writeoffs_usd)}</span></div>
            )}
            {Number(pnl?.at_cost_margin_usd) !== 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground" title="Kits sold to outside customers at vendor cost + freight — this waives exactly their P&L contribution so the sale nets zero">At-cost sales (margin waived)</span>
                {Number(pnl?.at_cost_margin_usd) > 0
                  ? <span className="text-red-600">−{fmtUSD(pnl?.at_cost_margin_usd)}</span>
                  : <span className="text-green-700">+{fmtUSD(-Number(pnl?.at_cost_margin_usd))}</span>}
              </div>
            )}
            {Number(pnl?.stock_cost_usd) > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground" title="Stock-plan commits: the group's own kits at vendor cost + freight, taken out of net profit BEFORE the split — no receivable, nobody pays this back">Group stock (at cost + freight, pre-split)</span>
                <span className="text-red-600">−{fmtUSD(pnl?.stock_cost_usd)}</span>
              </div>
            )}
            {Number(pnl?.stock_retail_usd) - Number(pnl?.stock_cost_usd) > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground" title="Product profit above counts the stock kits as if sold at GB price — this cancels that hypothetical margin, since group stock is never sold">Group stock margin (never sold)</span>
                <span className="text-red-600">−{fmtUSD(Number(pnl?.stock_retail_usd) - Number(pnl?.stock_cost_usd))}</span>
              </div>
            )}
            {Number(pnl?.adj_both_usd) !== 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Admin adjustments (both, at GB price)</span>
                {Number(pnl?.adj_both_usd) > 0
                  ? <span className="text-red-600">−{fmtUSD(pnl?.adj_both_usd)}</span>
                  : <span className="text-green-700">+{fmtUSD(-Number(pnl?.adj_both_usd))}</span>}
              </div>
            )}
            <div className="flex justify-between font-medium border-t pt-1"><span>Total revenue</span><span>{fmtUSD(pnl?.total_revenue_usd)}</span></div>
            <div className="flex justify-between mt-2"><span className="text-muted-foreground">Product profit</span><span>{fmtUSD(pnl?.product_profit_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Expenses (supplies, shipping, testing…)</span><span className="text-red-600">−{fmtUSD(pnl?.expenses_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Label costs (from shipments)</span><span className="text-red-600">−{fmtUSD(pnl?.label_costs_usd)}</span></div>
            {Number(pnl?.direct_freight_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Direct-ship freight (internal, to vendors)</span><span className="text-red-600">−{fmtUSD(pnl?.direct_freight_usd)}</span></div>
            )}
            {freightByVendor.length > 0 && (
              <div className="rounded bg-muted/50 px-2 py-1 space-y-0.5">
                <div className="text-[11px] font-semibold text-muted-foreground uppercase">Freight by vendor</div>
                {freightByVendor.map(f => (
                  <div key={f.vendor_code} className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {f.vendor_code}
                      {Number(f.kit_freight_usd) > 0 && ` · ${fmtUSD(f.kit_freight_usd)} per-kit (in product profit)`}
                      {Number(f.direct_freight_usd) > 0 && ` · ${fmtUSD(f.direct_freight_usd)} direct (${Number(f.boxes)} boxes)`}
                    </span>
                    <span>{fmtUSD(f.total_freight_usd)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-between font-semibold text-base border-t pt-1">
              <span>Net profit</span><span className={netProfit >= 0 ? 'text-green-700' : 'text-red-600'}>{fmtUSD(netProfit)}</span>
            </div>
            {((pnl?.adjustments || []).filter(a =>
              a.beneficiary !== 'both' && Number(a.value_usd) !== 0 && !(pnl?.splits || []).some(s => s.party === a.beneficiary)
            )).length > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                <span className="font-semibold">Unattributed adjustments:</span>{' '}
                {(pnl?.adjustments || [])
                  .filter(a => a.beneficiary !== 'both' && Number(a.value_usd) !== 0 && !(pnl?.splits || []).some(s => s.party === a.beneficiary))
                  .map(a => `${a.beneficiary} (${fmtUSD(a.value_usd)})`).join(', ')}
                {' '}— no current split party matches, so this value is deducted from NO ONE's payout. Reassign on the Products page.
              </div>
            )}
            {(pnl?.splits || []).map(s => {
              const personal = Number((pnl?.adjustments || []).find(a => a.beneficiary === s.party)?.value_usd || 0);
              return (
                <div key={s.party} className="flex justify-between text-muted-foreground">
                  <span>{s.party} ({Number(s.pct)}%){personal > 0 ? ` − ${fmtUSD(personal)} personal adjustments` : personal < 0 ? ` + ${fmtUSD(-personal)} adjustment credit` : ''}</span>
                  <span>{fmtUSD(netProfit * Number(s.pct) / 100 - personal)}</span>
                </div>
              );
            })}
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
        <CardHeader className="pb-2"><CardTitle className="text-base">Wallet coverage vs vendor owed (non-COA)</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={runCoverage} disabled={covRunning}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${covRunning ? 'animate-spin' : ''}`} /> Compare now
            </Button>
            <span className="text-xs text-muted-foreground">Live ETH + SOL wallet stablecoins vs what non-COA products still owe vendors (all campaigns).</span>
          </div>
          {covError && <p className="text-sm text-red-600">{covError}</p>}
          {covBalances && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-muted-foreground uppercase">In wallets (stablecoins)</div>
                {covBalances.map(b => (
                  <div key={b.name} className="flex justify-between text-muted-foreground">
                    <span>{b.name} ({b.chain})</span><span>{fmtUSD(b.usd)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold border-t pt-1">
                  <span>Total held</span><span>{fmtUSD(covHeld)}</span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="text-xs font-semibold text-muted-foreground uppercase">Still owed to vendors (non-COA)</div>
                {owedRows.map(v => (
                  <div key={v.vendor_code} className="flex justify-between text-muted-foreground">
                    <span>{v.vendor_code}</span><span>{fmtUSD(v.owed_usd)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold border-t pt-1">
                  <span>Total owed</span><span>{fmtUSD(covOwed)}</span>
                </div>
              </div>
            </div>
          )}
          {covBalances && (
            <div className={`text-base font-bold ${covHeld - covOwed >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {covHeld - covOwed >= 0
                ? `Over by ${fmtUSD(covHeld - covOwed)} — wallets cover what's owed`
                : `Under by ${fmtUSD(covOwed - covHeld)} — wallets do NOT cover what's owed`}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Counts USDC/USDT/PYUSD in active ETH and SOL wallets (native ETH/SOL excluded — no live USD pricing).
            Owed = non-COA product cost + those products' freight, minus vendor payments (COA-attributed payments excluded),
            clamped per vendor and summed across ALL campaigns — the wallets are one pool, so they're compared to everything the pool must cover.
          </p>
        </CardContent>
      </Card>

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
