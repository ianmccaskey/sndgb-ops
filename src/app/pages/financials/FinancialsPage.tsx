import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getPnl from '@/actions/financials/getPnl';
import listExpenses from '@/actions/financials/listExpenses';
import listAdjustments from '@/actions/campaign/listAdjustments';
import addExpense from '@/actions/financials/addExpense';
import deleteExpense from '@/actions/financials/deleteExpense';
import listWallets from '@/actions/financials/listWallets';
import addWalletSnapshot from '@/actions/financials/addWalletSnapshot';
import listNonCoaVendorOwed from '@/actions/vendors/listNonCoaVendorOwed';
import listFreightByVendor from '@/actions/financials/listFreightByVendor';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { getEvmBalances, getEvmBalancesAt, type WalletBalances } from '@/lib/moralis';
import getCampaignFirstOrder from '@/actions/financials/getCampaignFirstOrder';
import { getSolBalances } from '@/lib/helius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BarChart3, RefreshCw } from 'lucide-react';
import { DispersionTab, type Pnl, type DispAdjustment } from './DispersionTab';
import { Field } from '@/components/Field';
type Expense = { id: number; category: string; description: string; unit_cost_usd: string; qty: string; total_usd: string };
type Wallet = {
  id: number; name: string; chain: string; address: string | null; active: boolean;
  latest_balance_usd: string | null; latest_native_balance: string | null;
  latest_snapshot_at: string | null; latest_source: string | null;
  latest_breakdown: { usdc: number; usdt: number; pyusd: number; native: number } | string | null;
};
type OwedRow = { vendor_code: string; demand_usd: string; paid_usd: string; owed_usd: string };
type CovBalance = { name: string; chain: string; usd: number };

// one renderer for every per-token composition line (current snapshot AND
// opening balance) so the two can never drift in format. PYUSD omitted on
// Base (not issued there); zeros dimmed so "none held" ≠ "not checked";
// dust below display precision prints "<0.0001", never a bright "0"
function TokenBreakdownRow({ bd, chain, className = '' }: {
  bd: { usdc: number; usdt: number; pyusd: number; native: number }; chain: string; className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px] font-mono ${className}`}>
      {([
        ['USDC', bd.usdc, 2],
        ['USDT', bd.usdt, 2],
        ...(chain !== 'base' ? [['PYUSD', bd.pyusd, 2] as const] : []),
        [chain === 'sol' ? 'SOL' : 'ETH', bd.native, 4],
      ] as const).map(([sym, val, dp]) => {
        const n = Number(val);
        const text = !Number.isFinite(n) ? '—'
          : n > 0 && n < 1 / 10 ** dp ? `<${(1 / 10 ** dp).toFixed(dp)}`
          : n.toLocaleString('en-US', { maximumFractionDigits: dp });
        return (
          <span key={sym} className={`whitespace-nowrap ${n > 0 ? 'text-foreground/80' : 'text-muted-foreground/60'}`}>
            {sym} {text}
          </span>
        );
      })}
    </div>
  );
}

// jsonb usually arrives as an object, but the UI Bakery transport has
// re-typed values before — normalize a serialized-string arrival instead
// of rendering four NaNs
function walletBreakdown(w: Wallet): { usdc: number; usdt: number; pyusd: number; native: number } | null {
  const b = w.latest_breakdown;
  if (b == null) return null;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch { return null; }
  }
  return b;
}

export function FinancialsPage() {
  const { groupBuyId, settings } = useApp();
  const enabled = groupBuyId != null;
  const [rawPnl, , , reloadPnl] = useLoadAction(getPnl, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawFreight] = useLoadAction(listFreightByVendor, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawExpenses, , , reloadExpenses] = useLoadAction(listExpenses, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawWallets, , , reloadWallets] = useLoadAction(listWallets, [], {});
  // the dispersion tab's itemized rows load LAZILY on first tab activation —
  // Overview must never pay for (or depend on) a query it doesn't render
  const [finTab, setFinTab] = useState('overview');
  const [rawAdjustments, adjustmentsLoading, adjustmentsError] = useLoadAction(listAdjustments, [groupBuyId, finTab], { group_buy_id: groupBuyId }, { enabled: enabled && finTab === 'dispersion' });
  // a failed fetch must read as FAILURE, never as an empty dataset — an
  // empty stock table on a financial screen would be a silent lie
  const adjustmentsState: 'loading' | 'error' | 'ready' =
    adjustmentsError ? 'error' : (finTab === 'dispersion' && !adjustmentsLoading) ? 'ready' : 'loading';

  const pnl = firstRow<Pnl>(rawPnl);
  const expenses = rows<Expense>(rawExpenses);
  const adjustmentRows = rows<DispAdjustment>(rawAdjustments);
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

  // opening balance = chain state at the campaign's FIRST ORDER (placed_at
  // survives import, so this works no matter when the local campaign row
  // was scaffolded — Ian's snapshots don't reach back, the chain does)
  const [rawFirstOrder] = useLoadAction(getCampaignFirstOrder, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const firstOrderAt = firstRow<{ first_order_at: string | null; order_count: string }>(rawFirstOrder)?.first_order_at || null;
  type OpeningResult = { bd: WalletBalances; block: number; blockTime: string | null };
  // keyed by campaign AND wallet: a campaign switch must never relabel the
  // old campaign's block/balances with the new campaign's anchor (switching
  // back also restores the earlier result for free)
  const [opening, setOpening] = useState<Record<string, string | OpeningResult>>({});
  const oKey = (w: Wallet) => `${groupBuyId}:${w.id}`;
  const fetchOpening = async (w: Wallet) => {
    if (!firstOrderAt || !w.address) return;
    const k = oKey(w); // captured before the await — a mid-flight campaign switch lands on the old key
    setOpening(m => ({ ...m, [k]: 'fetching…' }));
    try {
      const key = settings.moralis_api_key;
      if (!key) throw new Error('Moralis key missing (Settings).');
      const b = await getEvmBalancesAt(key, w.chain as 'eth' | 'base', w.address, firstOrderAt);
      setOpening(m => ({ ...m, [k]: { bd: b, block: b.block, blockTime: b.blockTime } }));
    } catch (e: unknown) {
      setOpening(m => ({ ...m, [k]: e instanceof Error ? e.message : 'Failed to fetch opening balance' }));
    }
  };

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
      let bd: { usdc: number; usdt: number; pyusd: number; native: number };
      if (w.chain === 'sol') {
        const key = settings.helius_api_key;
        if (!key) throw new Error('Helius key missing (Settings).');
        const b = await getSolBalances(key, w.address);
        usd = b.usdc + b.usdt + b.pyusd; native = b.sol;
        bd = { usdc: b.usdc, usdt: b.usdt, pyusd: b.pyusd, native: b.sol };
      } else if (w.chain === 'eth' || w.chain === 'base') {
        const key = settings.moralis_api_key;
        if (!key) throw new Error('Moralis key missing (Settings).');
        const b = await getEvmBalances(key, w.chain as 'eth' | 'base', w.address);
        usd = b.usdc + b.usdt + b.pyusd; native = b.native;
        bd = { usdc: b.usdc, usdt: b.usdt, pyusd: b.pyusd, native: b.native };
      } else {
        throw new Error('Fiat wallets are manual — type a balance instead.');
      }
      await doSnapshot({ wallet_id: w.id, balance_usd: usd, native_balance: String(native), source: 'auto', breakdown: JSON.stringify(bd) });
      setRefreshing(r => ({ ...r, [w.id]: '' }));
      reloadWallets();
    } catch (e: unknown) {
      setRefreshing(r => ({ ...r, [w.id]: e instanceof Error ? e.message : 'failed' }));
    }
  };

  const saveManualBalance = async (w: Wallet) => {
    const v = Number(manualBalance[w.id]);
    if (!(v >= 0)) return;
    await doSnapshot({ wallet_id: w.id, balance_usd: v, native_balance: '', source: 'manual', breakdown: '' });
    setManualBalance(m => ({ ...m, [w.id]: '' }));
    reloadWallets();
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2 text-gradient">
          <BarChart3 className="h-6 w-6 text-cyan-300" /> Financials
        </h1>
        <p className="text-sm text-muted-foreground mt-1">P&L is computed live from orders, products, expenses, and shipments — nothing is typed twice.</p>
      </div>

      <Tabs value={finTab} onValueChange={setFinTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="dispersion">Profit dispersion</TabsTrigger>
        </TabsList>

        <TabsContent value="dispersion" className="mt-4">
          <DispersionTab pnl={pnl} expenses={expenses} adjustments={adjustmentRows}
            adjustmentsState={adjustmentsState} />
        </TabsContent>

        <TabsContent value="overview" className="mt-4 space-y-5">

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
              <div className="flex justify-between"><span className="text-muted-foreground">Comped product (free to customers)</span><span className="text-rose-400">−{fmtUSD(pnl?.comps_usd)}</span></div>
            )}
            {Number(pnl?.credits_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Customer credits</span><span className="text-rose-400">−{fmtUSD(pnl?.credits_usd)}</span></div>
            )}
            {Number(pnl?.writeoffs_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Write-offs (forgiven shortfalls)</span><span className="text-rose-400">−{fmtUSD(pnl?.writeoffs_usd)}</span></div>
            )}
            {Number(pnl?.at_cost_margin_usd) !== 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground" title="Kits sold to outside customers at vendor cost + freight — this waives exactly their P&L contribution so the sale nets zero">At-cost sales (margin waived)</span>
                {Number(pnl?.at_cost_margin_usd) > 0
                  ? <span className="text-rose-400">−{fmtUSD(pnl?.at_cost_margin_usd)}</span>
                  : <span className="text-emerald-300">+{fmtUSD(-Number(pnl?.at_cost_margin_usd))}</span>}
              </div>
            )}
            {Number(pnl?.stock_cost_usd) > 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground" title="Stock-plan commits: the group's own kits at vendor cost + freight, taken out of net profit BEFORE the split — no receivable, nobody pays this back">Group stock (at cost + freight, pre-split)</span>
                <span className="text-rose-400">−{fmtUSD(pnl?.stock_cost_usd)}</span>
              </div>
            )}
            {/* sign-aware and shown for ANY non-zero delta: a lowered GB
                price or risen cost can push it negative, and hiding it
                would leave the visible lines composing to the wrong net */}
            {Number(pnl?.stock_retail_usd) - Number(pnl?.stock_cost_usd) !== 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground" title="Product profit above counts the stock kits as if sold at GB price — this cancels that hypothetical margin, since group stock is never sold. Also absorbs any cost/freight drift since commit: the line above shows the committed snapshot, while the books track the live vendor cost (what we will actually pay).">Group stock margin (never sold)</span>
                {Number(pnl?.stock_retail_usd) - Number(pnl?.stock_cost_usd) > 0
                  ? <span className="text-rose-400">−{fmtUSD(Number(pnl?.stock_retail_usd) - Number(pnl?.stock_cost_usd))}</span>
                  : <span className="text-emerald-300">+{fmtUSD(Number(pnl?.stock_cost_usd) - Number(pnl?.stock_retail_usd))}</span>}
              </div>
            )}
            {Number(pnl?.adj_both_usd) !== 0 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Admin adjustments (both, at GB price)</span>
                {Number(pnl?.adj_both_usd) > 0
                  ? <span className="text-rose-400">−{fmtUSD(pnl?.adj_both_usd)}</span>
                  : <span className="text-emerald-300">+{fmtUSD(-Number(pnl?.adj_both_usd))}</span>}
              </div>
            )}
            <div className="flex justify-between font-medium border-t pt-1"><span>Total revenue</span><span>{fmtUSD(pnl?.total_revenue_usd)}</span></div>
            <div className="flex justify-between mt-2"><span className="text-muted-foreground">Product profit</span><span>{fmtUSD(pnl?.product_profit_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Expenses (supplies, shipping, testing…)</span><span className="text-rose-400">−{fmtUSD(pnl?.expenses_usd)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Label costs (from shipments)</span><span className="text-rose-400">−{fmtUSD(pnl?.label_costs_usd)}</span></div>
            {Number(pnl?.direct_freight_usd) > 0 && (
              <div className="flex justify-between"><span className="text-muted-foreground">Direct-ship freight (internal, to vendors)</span><span className="text-rose-400">−{fmtUSD(pnl?.direct_freight_usd)}</span></div>
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
              <span>Net profit</span><span className={netProfit >= 0 ? 'text-emerald-300' : 'text-rose-400'}>{fmtUSD(netProfit)}</span>
            </div>
            {((pnl?.adjustments || []).filter(a =>
              a.beneficiary !== 'both' && Number(a.value_usd) !== 0 && !(pnl?.splits || []).some(s => s.party === a.beneficiary)
            )).length > 0 && (
              <div className="rounded border border-amber-400/40 bg-amber-400/5 p-2 text-xs text-amber-200">
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
                      ? <>{fmtUSD(w.latest_balance_usd)} stable{Number(w.latest_native_balance) > 0 && !walletBreakdown(w) ? ` + ${Number(w.latest_native_balance).toFixed(4)} native` : ''} · {fmtDateTime(w.latest_snapshot_at)} ({w.latest_source})</>
                      : 'No snapshot yet'}
                  </div>
                  {/* per-token detail from the same snapshot — composition
                      here, roll-up + provenance above (the summary drops its
                      "+ native" fragment when this row names the asset) */}
                  {(() => {
                    const bd = walletBreakdown(w);
                    if (!bd || !['eth', 'sol', 'base'].includes(w.chain)) return null;
                    return <TokenBreakdownRow bd={bd} chain={w.chain} className="mt-0.5" />;
                  })()}
                  {/* opening balance: chain state at the campaign's first
                      order — EVM only (Moralis balance-at-block); Solana has
                      no at-date API, so the SOL row hands over the anchor
                      timestamp for a manual Solscan read instead */}
                  {(w.chain === 'eth' || w.chain === 'base') && w.address && firstOrderAt && (
                    opening[oKey(w)] == null ? (
                      <button className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground mt-0.5 py-2.5 -my-2 text-left"
                        onClick={() => fetchOpening(w)}>
                        Show balance at buy start ({fmtDateTime(firstOrderAt)})
                      </button>
                    ) : opening[oKey(w)] === 'fetching…' ? (
                      <div className="text-[11px] mt-0.5 text-muted-foreground">Reading chain state at buy start…</div>
                    ) : typeof opening[oKey(w)] === 'string' ? (
                      <div className="text-[11px] mt-0.5 text-rose-400">
                        {String(opening[oKey(w)])}{' '}
                        <button className="underline underline-offset-2 text-muted-foreground hover:text-foreground py-2.5 -my-2"
                          onClick={() => fetchOpening(w)}>Retry</button>
                      </div>
                    ) : (
                      <div className="mt-0.5">
                        {/* block time shown alongside the anchor so a
                            timezone drift in the date→block resolution
                            would be visible instead of silent */}
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          At buy start · {fmtDateTime(firstOrderAt)} · block {(opening[oKey(w)] as OpeningResult).block}
                          {(opening[oKey(w)] as OpeningResult).blockTime && <> ({fmtDateTime((opening[oKey(w)] as OpeningResult).blockTime!)})</>}
                        </div>
                        <TokenBreakdownRow bd={(opening[oKey(w)] as OpeningResult).bd} chain={w.chain} />
                      </div>
                    )
                  )}
                  {w.chain === 'sol' && firstOrderAt && (
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      Buy started {fmtDateTime(firstOrderAt)} — Solana has no balance-at-date API; read that moment off{' '}
                      {w.address
                        ? <a className="underline underline-offset-2 hover:text-foreground" href={`https://solscan.io/account/${w.address}`} target="_blank" rel="noreferrer">Solscan's balance history</a>
                        : "Solscan's balance history"}.
                    </div>
                  )}
                  {refreshing[w.id] && refreshing[w.id] !== 'fetching…' && <div className="text-xs text-rose-400">{refreshing[w.id]}</div>}
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
          {covError && <p className="text-sm text-rose-400">{covError}</p>}
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
            <div className={`text-base font-bold ${covHeld - covOwed >= 0 ? 'text-emerald-300' : 'text-rose-400'}`}>
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
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-[8rem_1fr_7rem_5rem_auto] sm:items-end">
            <Field label="Category">
              <Select value={eCat} onValueChange={setECat}>
                <SelectTrigger className="h-9 w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['supplies', 'shipping', 'reship', 'testing', 'other'].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Description" className="col-span-2 sm:col-span-1 order-first sm:order-none">
              <Input placeholder="e.g. 6x4x4 boxes" value={eDesc} onChange={e => setEDesc(e.target.value)} className="h-9" />
            </Field>
            <Field label="Unit cost $">
              <Input inputMode="decimal" value={eCost} onChange={e => setECost(e.target.value)} className="h-9" />
            </Field>
            <Field label="Qty">
              <Input inputMode="numeric" value={eQty} onChange={e => setEQty(e.target.value)} className="h-9" />
            </Field>
            <Button size="sm" className="h-9 self-end" onClick={submitExpense}>Add</Button>
          </div>
          {eError && <p className="text-sm text-rose-400">{eError}</p>}
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
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-400"
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

        </TabsContent>
      </Tabs>
    </div>
  );
}
