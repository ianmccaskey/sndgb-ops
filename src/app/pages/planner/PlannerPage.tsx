import React, { useMemo, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getStockPlan from '@/actions/planner/getStockPlan';
import saveStockPlanSources from '@/actions/planner/saveStockPlanSources';
import upsertStockPlanItem from '@/actions/planner/upsertStockPlanItem';
import deleteStockPlanItem from '@/actions/planner/deleteStockPlanItem';
import markStockPlanItemOrdered from '@/actions/planner/markStockPlanItemOrdered';
import listAtCostReceivables from '@/actions/planner/listAtCostReceivables';
import listWallets from '@/actions/financials/listWallets';
import listVendors from '@/actions/vendors/listVendors';
import listVendorProductProgress from '@/actions/vendors/listVendorProductProgress';
import listNonCoaVendorOwed from '@/actions/vendors/listNonCoaVendorOwed';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import addVendorPayment from '@/actions/vendors/addVendorPayment';
import addWalletSnapshot from '@/actions/financials/addWalletSnapshot';
import { getEvmBalances } from '@/lib/moralis';
import { getSolBalances } from '@/lib/helius';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtNum, fmtDateTime } from '@/lib/fmt';
import { ResponsiveContainer, Sankey, Tooltip, Rectangle, Layer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { GitBranch, AlertTriangle, RefreshCw } from 'lucide-react';

/*
 * Stock Planner (dataviz-skill compliant):
 * - one Sankey: sources -> owed reservation + profit pool -> allocations
 * - fixed hue per entity CLASS, never per rank: wallets blue, outside teal,
 *   receivables amber (pending money), hypothetical cash gray (not real yet),
 *   owed red, pool/unallocated green, product allocations violet, committed
 *   orders a deeper violet
 * - color is never the only signal: every node label carries its $ value,
 *   warnings are text badges, pending/hypothetical sources say so in words
 */
const KIND_COLORS: Record<string, string> = {
  wallet: 'rgb(37 99 235)',      // blue-600 — real crypto held
  outside: 'rgb(13 148 136)',    // teal-600 — attributable outside crypto
  receivable: 'rgb(217 119 6)',  // amber-600 — expected, not yet received
  cash: 'rgb(113 113 122)',      // zinc-500 — hypothetical (entered figure)
  owed: 'rgb(220 38 38)',        // red-600 — reserved for vendors
  pool: 'rgb(22 163 74)',        // green-600 — available for stock
  alloc: 'rgb(124 58 237)',      // violet-600 — planned allocation
  ordered: 'rgb(76 29 149)',     // violet-900 — committed (vendor paid)
  rest: 'rgb(134 239 172)',      // green-300 — unallocated remainder
};

type PlanItem = {
  id: number; group_buy_product_id: number; sku_code: string; vendor_code: string;
  kits: string; unit_cost_usd: string; freight_usd: string; planned_value_usd: string;
  ordered_at: string | null; ordered_by: string | null; ordered_value_usd: string | null;
};
type Plan = {
  outside_total_usd: string; outside_max_usd: string; cash_assignable_usd: string;
  updated_by: string | null; updated_at: string | null; items: PlanItem[] | null;
};
type Wallet = {
  id: number; name: string; chain: string; address: string | null; active: boolean;
  latest_balance_usd: string | null; latest_snapshot_at: string | null;
};
type Vendor = { id: number; code: string; active: boolean };
type OwedRow = { vendor_code: string; owed_usd: string };
type Receivable = { id: number; sku_code: string; qty: string; expected_usd: string; reason: string; created_at: string };
type CampaignProduct = {
  group_buy_product_id: number; sku_code: string; vendor_code: string;
  unit_cost_usd: string; freight_usd: string; cost_tier_qty: string | null; status: string;
};
type Progress = { group_buy_product_id: number; kits_demand: string; kits_paid: string };

type SNode = { name: string; kind: string; usd: number; hint?: string };
type SLink = { source: number; target: number; value: number; kind: string };

/** Sources -> (owed + pool) -> (allocations + unallocated). Pure. */
function buildSankey(args: {
  walletRows: { name: string; usd: number }[];
  owedTotal: number; outsideMax: number; outsideTotal: number;
  receivables: number; cash: number;
  items: { label: string; usd: number; ordered: boolean }[];
}): { nodes: SNode[]; links: SLink[]; uncoveredOwed: number; overAllocated: number; pool: number } {
  const nodes: SNode[] = [];
  const links: SLink[] = [];
  const add = (n: SNode) => nodes.push(n) - 1 + 1 - 1; // index of pushed node
  const idx = (n: SNode) => { nodes.push(n); return nodes.length - 1; };

  const walletTotal = args.walletRows.reduce((s, w) => s + w.usd, 0);
  const owedFromWallets = Math.min(args.owedTotal, walletTotal);
  const uncoveredOwed = Math.max(args.owedTotal - walletTotal, 0);
  const walletProfit = walletTotal - owedFromWallets;
  const pool = walletProfit + args.outsideMax + args.receivables + args.cash;

  const allocTotal = args.items.reduce((s, i) => s + i.usd, 0);
  const unallocated = Math.max(pool - allocTotal, 0);
  const overAllocated = Math.max(allocTotal - pool, 0);

  // middle nodes first so both columns exist even when a side is empty
  const owedIdx = args.owedTotal > 0 ? idx({ name: 'Owed to vendors', kind: 'owed', usd: args.owedTotal, hint: uncoveredOwed > 0 ? `wallets cover ${fmtUSD(owedFromWallets)}; ${fmtUSD(uncoveredOwed)} uncovered` : undefined }) : -1;
  const poolIdx = idx({ name: 'Available for stock', kind: 'pool', usd: pool });

  for (const w of args.walletRows) {
    if (w.usd <= 0) continue;
    const i = idx({ name: w.name, kind: 'wallet', usd: w.usd });
    const share = walletTotal > 0 ? owedFromWallets * (w.usd / walletTotal) : 0;
    if (share > 0.005 && owedIdx >= 0) links.push({ source: i, target: owedIdx, value: +share.toFixed(2), kind: 'owed' });
    const rest = w.usd - share;
    if (rest > 0.005) links.push({ source: i, target: poolIdx, value: +rest.toFixed(2), kind: 'wallet' });
  }
  if (args.outsideMax > 0) {
    const i = idx({ name: 'Outside wallet (attributable)', kind: 'outside', usd: args.outsideMax, hint: `attributable ${fmtUSD(args.outsideMax)} of ${fmtUSD(args.outsideTotal)} held` });
    links.push({ source: i, target: poolIdx, value: args.outsideMax, kind: 'outside' });
  }
  if (args.receivables > 0) {
    const i = idx({ name: 'Expected at-cost payments', kind: 'receivable', usd: args.receivables, hint: 'awaiting customer payment — not in the wallets yet' });
    links.push({ source: i, target: poolIdx, value: args.receivables, kind: 'receivable' });
  }
  if (args.cash > 0) {
    const i = idx({ name: 'Cash profit (hypothetical crypto)', kind: 'cash', usd: args.cash, hint: 'entered figure — convertible cash profit, not held as crypto' });
    links.push({ source: i, target: poolIdx, value: args.cash, kind: 'cash' });
  }
  for (const it of args.items) {
    if (it.usd <= 0) continue;
    const i = idx({ name: it.label, kind: it.ordered ? 'ordered' : 'alloc', usd: it.usd });
    links.push({ source: poolIdx, target: i, value: it.usd, kind: it.ordered ? 'ordered' : 'alloc' });
  }
  if (unallocated > 0.005) {
    const i = idx({ name: 'Unallocated', kind: 'rest', usd: unallocated });
    links.push({ source: poolIdx, target: i, value: +unallocated.toFixed(2), kind: 'rest' });
  }
  void add;
  return { nodes, links, uncoveredOwed, overAllocated, pool };
}

function PlannerNode(props: { x?: number; y?: number; width?: number; height?: number; index?: number; payload?: SNode; containerWidth?: number }) {
  const { x = 0, y = 0, width = 0, height = 0, payload, containerWidth = 0 } = props;
  if (!payload) return <g />;
  const isRight = x + width > containerWidth / 2;
  const color = KIND_COLORS[payload.kind] || KIND_COLORS.alloc;
  return (
    <Layer>
      <Rectangle x={x} y={y} width={width} height={height} fill={color} fillOpacity={0.9} radius={2} />
      <text x={isRight ? x - 6 : x + width + 6} y={y + height / 2 - 2} textAnchor={isRight ? 'end' : 'start'}
        fontSize={11} fill="var(--foreground)">{payload.name}</text>
      <text x={isRight ? x - 6 : x + width + 6} y={y + height / 2 + 11} textAnchor={isRight ? 'end' : 'start'}
        fontSize={10} fill="var(--muted-foreground)">{fmtUSD(payload.usd)}</text>
    </Layer>
  );
}

function PlannerLink(props: { sourceX?: number; targetX?: number; sourceY?: number; targetY?: number; sourceControlX?: number; targetControlX?: number; linkWidth?: number; payload?: { kind?: string } }) {
  const { sourceX = 0, targetX = 0, sourceY = 0, targetY = 0, sourceControlX = 0, targetControlX = 0, linkWidth = 0, payload } = props;
  const color = KIND_COLORS[payload?.kind || 'alloc'] || KIND_COLORS.alloc;
  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none" stroke={color} strokeOpacity={payload?.kind === 'cash' ? 0.25 : 0.35} strokeWidth={linkWidth}
      strokeDasharray={payload?.kind === 'cash' || payload?.kind === 'receivable' ? '6 4' : undefined}
    />
  );
}

export function PlannerPage() {
  const { groupBuyId, userName, settings } = useApp();
  const enabled = groupBuyId != null;
  const [rawPlan, , , reloadPlan] = useLoadAction(getStockPlan, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawWallets, , , reloadWallets] = useLoadAction(listWallets, [], {});
  const [rawVendors] = useLoadAction(listVendors, [], {});
  const [rawOwed] = useLoadAction(listNonCoaVendorOwed, [], {});
  const [rawRecv] = useLoadAction(listAtCostReceivables, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawProducts] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawProgress, , , reloadProgress] = useLoadAction(listVendorProductProgress, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });

  const plan = firstRow<Plan>(rawPlan);
  const wallets = rows<Wallet>(rawWallets);
  const vendors = rows<Vendor>(rawVendors);
  const owedRows = rows<OwedRow>(rawOwed);
  const receivables = rows<Receivable>(rawRecv);
  const products = rows<CampaignProduct>(rawProducts);
  const progress = rows<Progress>(rawProgress);
  const items: PlanItem[] = useMemo(() => plan?.items || [], [plan]);

  const [doSaveSources] = useMutateAction(saveStockPlanSources);
  const [doUpsertItem] = useMutateAction(upsertStockPlanItem);
  const [doDeleteItem] = useMutateAction(deleteStockPlanItem);
  const [doMarkOrdered] = useMutateAction(markStockPlanItemOrdered);
  const [doPay] = useMutateAction(addVendorPayment);
  const [doSnapshot] = useMutateAction(addWalletSnapshot);

  // sources form (prefilled from the saved plan once it loads)
  const [srcLoadedFor, setSrcLoadedFor] = useState<string>('');
  const [srcOutsideTotal, setSrcOutsideTotal] = useState('0');
  const [srcOutsideMax, setSrcOutsideMax] = useState('0');
  const [srcCash, setSrcCash] = useState('0');
  const [srcMsg, setSrcMsg] = useState('');
  const planKey = plan ? `${plan.outside_total_usd}|${plan.outside_max_usd}|${plan.cash_assignable_usd}` : '';
  if (plan && srcLoadedFor !== planKey) {
    setSrcLoadedFor(planKey);
    setSrcOutsideTotal(String(Number(plan.outside_total_usd)));
    setSrcOutsideMax(String(Number(plan.outside_max_usd)));
    setSrcCash(String(Number(plan.cash_assignable_usd)));
  }

  // allocation form
  const [aProduct, setAProduct] = useState('');
  const [aKits, setAKits] = useState('');
  const [aMsg, setAMsg] = useState('');

  // commit ("Mark ordered") dialog
  const [ordering, setOrdering] = useState<PlanItem | null>(null);
  const [oDate, setODate] = useState('');
  const [oWallet, setOWallet] = useState('');
  const [oMethod, setOMethod] = useState('USDC');
  const [oRef, setORef] = useState('');
  const [oMsg, setOMsg] = useState('');
  const [oSaving, setOSaving] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  const cryptoWallets = useMemo(
    () => wallets.filter(w => w.active && (w.chain === 'eth' || w.chain === 'sol')),
    [wallets]);
  const owedTotal = owedRows.reduce((s, v) => s + Number(v.owed_usd), 0);
  const receivableTotal = receivables.reduce((s, r) => s + Number(r.expected_usd), 0);
  const allocatableProducts = products.filter(p =>
    p.status === 'active' && p.cost_tier_qty == null && !/^coa/i.test(p.sku_code));
  const aChosen = allocatableProducts.find(p => String(p.group_buy_product_id) === aProduct);
  const aPerKit = aChosen ? Number(aChosen.unit_cost_usd) + Number(aChosen.freight_usd) : 0;

  const sankey = useMemo(() => buildSankey({
    walletRows: cryptoWallets.map(w => ({ name: w.name, usd: Number(w.latest_balance_usd || 0) })),
    owedTotal,
    outsideMax: Number(plan?.outside_max_usd || 0),
    outsideTotal: Number(plan?.outside_total_usd || 0),
    receivables: receivableTotal,
    cash: Number(plan?.cash_assignable_usd || 0),
    items: items.map(i => ({
      label: `${i.sku_code} × ${fmtNum(i.kits)}${i.ordered_at ? ' (ordered)' : ''}`,
      usd: Number(i.ordered_at ? (i.ordered_value_usd ?? i.planned_value_usd) : i.planned_value_usd),
      ordered: i.ordered_at != null,
    })),
  }), [cryptoWallets, owedTotal, plan, receivableTotal, items]);

  const refreshBalances = async () => {
    setRefreshing(true); setRefreshMsg('');
    try {
      // sequential on purpose — the providers rate-limit bursts
      for (const w of cryptoWallets) {
        if (!w.address) continue;
        if (w.chain === 'sol') {
          if (!settings.helius_api_key) throw new Error('Helius key missing (Settings).');
          const b = await getSolBalances(settings.helius_api_key, w.address);
          await doSnapshot({ wallet_id: w.id, balance_usd: b.usdc + b.usdt + b.pyusd, native_balance: String(b.sol), source: 'auto' });
        } else {
          if (!settings.moralis_api_key) throw new Error('Moralis key missing (Settings).');
          const b = await getEvmBalances(settings.moralis_api_key, 'eth', w.address);
          await doSnapshot({ wallet_id: w.id, balance_usd: b.usdc + b.usdt + b.pyusd, native_balance: String(b.native), source: 'auto' });
        }
      }
      reloadWallets();
    } catch (e: unknown) {
      setRefreshMsg(e instanceof Error ? e.message : 'Failed to refresh balances');
    } finally {
      setRefreshing(false);
    }
  };

  const saveSources = async () => {
    setSrcMsg('');
    for (const [label, v] of [['Outside total', srcOutsideTotal], ['Outside attributable', srcOutsideMax], ['Cash assignable', srcCash]] as const) {
      if (!/^\d+(?:\.\d{1,2})?$/.test(v.trim())) { setSrcMsg(`${label} must be a dollar amount with at most 2 decimals.`); return; }
    }
    if (Number(srcOutsideMax) > Number(srcOutsideTotal)) { setSrcMsg('Attributable amount cannot exceed what the outside wallet holds.'); return; }
    const res = await doSaveSources({
      group_buy_id: groupBuyId, outside_total_usd: srcOutsideTotal.trim(),
      outside_max_usd: srcOutsideMax.trim(), cash_assignable_usd: srcCash.trim(), actor: userName,
    }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) { setSrcMsg('Not saved — check the amounts.'); return; }
    reloadPlan();
  };

  const addAllocation = async () => {
    setAMsg('');
    if (!aProduct) { setAMsg('Pick a product.'); return; }
    if (!/^\d+$/.test(aKits.trim()) || !(Number(aKits) > 0)) { setAMsg('Kits must be a positive whole number.'); return; }
    const res = await doUpsertItem({
      group_buy_id: groupBuyId, group_buy_product_id: Number(aProduct), kits: aKits.trim(), actor: userName,
    }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
      setAMsg('Not saved — the product must be active, flat-cost, in this campaign, and the line not already ordered.');
      return;
    }
    setAProduct(''); setAKits('');
    reloadPlan();
  };

  const removeAllocation = async (it: PlanItem) => {
    const res = await doDeleteItem({ item_id: it.id, actor: userName }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) { setAMsg('Not removed — an ordered line is locked to its vendor payment.'); return; }
    reloadPlan();
  };

  const openOrderDialog = (it: PlanItem) => {
    setOrdering(it); setODate(''); setOWallet(''); setOMethod('USDC'); setORef(''); setOMsg('');
  };

  const commitOrder = async () => {
    if (!ordering) return;
    if (!oDate) { setOMsg('Date is required.'); return; }
    if (!oWallet) { setOMsg('Pick the wallet the payment came from.'); return; }
    const vendor = vendors.find(v => v.code === ordering.vendor_code);
    if (!vendor) { setOMsg('Vendor not found.'); return; }
    const kits = Number(ordering.kits);
    // one payment line carrying the FULL cost+freight value: floating kits
    // are not in freight demand, so the vendor freight ledger (demand-capped)
    // deliberately isn't used — the note carries the breakdown
    const amount = Math.round(kits * (Number(ordering.unit_cost_usd) + Number(ordering.freight_usd)) * 100) / 100;
    const prog = progress.find(p => Number(p.group_buy_product_id) === Number(ordering.group_buy_product_id));
    const kitsOwed = prog ? Math.round((Number(prog.kits_demand) - Number(prog.kits_paid)) * 100) / 100 : 0;
    const over = kits > kitsOwed;
    if (over && !window.confirm(
      `${ordering.sku_code}: this pays for ${fmtNum(kits)} kits but only ${fmtNum(Math.max(kitsOwed, 0))} are still owed by demand — the rest is deliberate personal stock (over-buy).\n\nRecord anyway?`)) {
      return;
    }
    setOSaving(true); setOMsg('');
    try {
      const res = await doPay({
        vendor_id: vendor.id, group_buy_id: groupBuyId, paid_on: oDate,
        amount_usd: amount, wallet_id: oWallet, method: oMethod, receipt_ref: oRef.trim(),
        note: `stock plan: ${ordering.sku_code} × ${fmtNum(kits)} personal stock (cost+freight)`,
        kits_qty: String(kits), freight_usd: '', group_buy_product_id: String(ordering.group_buy_product_id),
        allow_over: over ? 'true' : '', confirmed_owed: over ? String(Math.max(kitsOwed, 0)) : '',
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
        setOMsg('Payment refused — owed changed while confirming (someone else recorded a payment?). Refresh and retry.');
        return;
      }
      const marked = await doMarkOrdered({ item_id: ordering.id, ordered_value_usd: amount.toFixed(2), actor: userName }) as unknown[] | null;
      if (!(Array.isArray(marked) ? marked.length > 0 : !!marked)) {
        setOMsg('Payment recorded, but the plan line was already marked — check the Vendors page for a duplicate payment.');
        return;
      }
      setOrdering(null);
      reloadPlan(); reloadProgress();
    } catch (e: unknown) {
      setOMsg(e instanceof Error ? e.message : 'Failed to record');
    } finally {
      setOSaving(false);
    }
  };

  const sankeyData = { nodes: sankey.nodes, links: sankey.links };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <GitBranch className="h-6 w-6 text-violet-600" /> Stock Planner
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          What the wallets hold, what vendors are owed, and how the rest distributes into personal-stock orders (valued at vendor cost + freight). The plan is saved and shared.
        </p>
      </div>

      {sankey.uncoveredOwed > 0 && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span>Vendor owed exceeds the crypto wallets by <span className="font-semibold">{fmtUSD(sankey.uncoveredOwed)}</span> — the pool below assumes the other sources also help cover stock, but the owed gap comes first.</span>
        </div>
      )}
      {sankey.overAllocated > 0 && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span>Over-allocated by <span className="font-semibold">{fmtUSD(sankey.overAllocated)}</span> — planned purchases exceed the available pool ({fmtUSD(sankey.pool)}).</span>
        </div>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Money flow</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={refreshBalances} disabled={refreshing}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
              {refreshing ? 'Fetching…' : 'Refresh balances'}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {refreshMsg && <p className="text-xs text-red-600 mb-2">{refreshMsg}</p>}
          {sankey.links.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Nothing to draw yet — refresh wallet balances or enter sources below.</p>
          ) : (
            <div className="w-full" style={{ height: 440 }}>
              <ResponsiveContainer width="100%" height="100%">
                <Sankey
                  data={sankeyData}
                  nodePadding={28}
                  margin={{ top: 12, right: 200, bottom: 12, left: 12 }}
                  node={<PlannerNode />}
                  link={<PlannerLink />}
                >
                  <Tooltip formatter={(v: number) => fmtUSD(v)} />
                </Sankey>
              </ResponsiveContainer>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            Dashed flows are money not in the wallets yet (expected at-cost payments, hypothetical cash-derived crypto). The pool mixes sources — no specific dollar funds a specific kit.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Sources</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1">
              {cryptoWallets.map(w => (
                <div key={w.id} className="flex justify-between">
                  <span className="text-muted-foreground">{w.name} ({w.chain})</span>
                  <span>
                    {fmtUSD(w.latest_balance_usd || 0)}
                    {w.latest_snapshot_at && <span className="block text-[10px] text-muted-foreground text-right">as of {fmtDateTime(w.latest_snapshot_at)}</span>}
                  </span>
                </div>
              ))}
              <div className="flex justify-between border-t pt-1">
                <span className="text-muted-foreground">Owed to vendors (non-COA, all campaigns)</span>
                <span className="text-red-600">−{fmtUSD(owedTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Expected at-cost payments ({receivables.length})</span>
                <span className="text-amber-700">{fmtUSD(receivableTotal)}</span>
              </div>
            </div>
            <div className="border-t pt-2 space-y-2">
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-muted-foreground w-44">Outside wallet holds</span>
                <Input value={srcOutsideTotal} onChange={e => setSrcOutsideTotal(e.target.value)} className="h-8 w-28 text-sm" />
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-muted-foreground w-44">…of which attributable</span>
                <Input value={srcOutsideMax} onChange={e => setSrcOutsideMax(e.target.value)} className="h-8 w-28 text-sm" />
              </div>
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-muted-foreground w-44" title="Cash profit you could convert to crypto — a what-if figure, not money in the wallets">Cash profit assignable</span>
                <Input value={srcCash} onChange={e => setSrcCash(e.target.value)} className="h-8 w-28 text-sm" />
              </div>
              <Button size="sm" className="h-8" onClick={saveSources}>Save sources</Button>
              {srcMsg && <p className="text-xs text-red-600">{srcMsg}</p>}
              {plan?.updated_by && <p className="text-[11px] text-muted-foreground">Last saved by {plan.updated_by} {plan.updated_at ? fmtDateTime(plan.updated_at) : ''}</p>}
            </div>
            {receivables.length > 0 && (
              <div className="border-t pt-2">
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Awaiting at-cost payments</p>
                {receivables.map(r => (
                  <div key={r.id} className="flex justify-between text-xs">
                    <span className="text-muted-foreground truncate" title={r.reason}>{r.sku_code} × {fmtNum(r.qty)} — {r.reason}</span>
                    <span className="text-amber-700 shrink-0 ml-2">{fmtUSD(r.expected_usd)}</span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Personal-stock allocations</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap gap-2">
              <Select value={aProduct} onValueChange={setAProduct}>
                <SelectTrigger className="h-9 flex-1 min-w-44"><SelectValue placeholder="Product" /></SelectTrigger>
                <SelectContent>
                  {allocatableProducts.map(p => (
                    <SelectItem key={p.group_buy_product_id} value={String(p.group_buy_product_id)}>
                      {p.sku_code} ({fmtUSD(Number(p.unit_cost_usd) + Number(p.freight_usd))}/kit)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input placeholder="Kits" value={aKits} onChange={e => setAKits(e.target.value)} className="h-9 w-20" />
              <Button size="sm" onClick={addAllocation}>Add</Button>
            </div>
            {aChosen && Number(aKits) > 0 && (
              <p className="text-xs text-muted-foreground">= {fmtUSD(Math.round(Number(aKits) * aPerKit * 100) / 100)} at vendor cost + freight</p>
            )}
            {aMsg && <p className="text-xs text-red-600">{aMsg}</p>}
            <div className="space-y-1 pt-1">
              {items.map(it => (
                <div key={it.id} className="flex items-center justify-between gap-2 border-b last:border-0 pb-1">
                  <span className="min-w-0 truncate">
                    {it.sku_code} × {fmtNum(it.kits)}
                    <span className="text-muted-foreground"> · {it.vendor_code}</span>
                    {it.ordered_at && (
                      <span className="ml-1.5 rounded bg-violet-100 text-violet-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                        title={`Vendor payment recorded ${fmtDateTime(it.ordered_at)} by ${it.ordered_by}`}>ordered</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    {fmtUSD(it.ordered_at ? (it.ordered_value_usd ?? it.planned_value_usd) : it.planned_value_usd)}
                    {!it.ordered_at && (
                      <>
                        <Button size="sm" variant="outline" className="h-6 px-1.5 text-[11px]" onClick={() => openOrderDialog(it)}>Mark ordered</Button>
                        <Button size="sm" variant="ghost" className="h-6 px-1 text-[11px] text-red-600" onClick={() => removeAllocation(it)}>✕</Button>
                      </>
                    )}
                  </span>
                </div>
              ))}
              {items.length === 0 && <p className="text-xs text-muted-foreground">No allocations yet — pick a product above.</p>}
            </div>
            <p className="text-[11px] text-muted-foreground">
              "Mark ordered" records the REAL vendor payment (same guarded path as the Vendors page, over-buy confirm included) and locks the line.
            </p>
          </CardContent>
        </Card>
      </div>

      <Dialog open={ordering != null} onOpenChange={o => { if (!o) setOrdering(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Record vendor payment — {ordering?.sku_code} × {ordering ? fmtNum(ordering.kits) : ''}</DialogTitle>
          </DialogHeader>
          {ordering && (
            <div className="space-y-2 text-sm">
              <p className="text-muted-foreground">
                {fmtUSD(Math.round(Number(ordering.kits) * (Number(ordering.unit_cost_usd) + Number(ordering.freight_usd)) * 100) / 100)} to {ordering.vendor_code} ({fmtNum(ordering.kits)} kits × {fmtUSD(Number(ordering.unit_cost_usd) + Number(ordering.freight_usd))} cost+freight)
              </p>
              <div className="flex flex-wrap gap-2">
                <Input type="date" value={oDate} disabled={oSaving} onChange={e => setODate(e.target.value)} className="h-9 w-40" />
                <Select value={oWallet} onValueChange={setOWallet}>
                  <SelectTrigger className="h-9 flex-1 min-w-36"><SelectValue placeholder="From wallet" /></SelectTrigger>
                  <SelectContent>
                    {wallets.filter(w => w.active).map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Input placeholder="Method" value={oMethod} disabled={oSaving} onChange={e => setOMethod(e.target.value)} className="h-9 w-28" />
                <Input placeholder="Receipt / tx ref (optional)" value={oRef} disabled={oSaving} onChange={e => setORef(e.target.value)} className="h-9 flex-1 min-w-40" />
              </div>
              {oMsg && <p className="text-xs text-red-600">{oMsg}</p>}
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" disabled={oSaving} onClick={() => setOrdering(null)}>Cancel</Button>
                <Button size="sm" disabled={oSaving} onClick={commitOrder}>{oSaving ? 'Recording…' : 'Record payment'}</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
