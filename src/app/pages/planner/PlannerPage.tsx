import React, { useMemo, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getStockPlan from '@/actions/planner/getStockPlan';
import saveStockPlanSources from '@/actions/planner/saveStockPlanSources';
import upsertStockPlanItem from '@/actions/planner/upsertStockPlanItem';
import deleteStockPlanItem from '@/actions/planner/deleteStockPlanItem';
import orderStockPlanItem from '@/actions/planner/orderStockPlanItem';
import commitStockPlan from '@/actions/planner/commitStockPlan';
import listAtCostReceivables from '@/actions/planner/listAtCostReceivables';
import listWallets from '@/actions/financials/listWallets';
import listVendorProductProgress from '@/actions/vendors/listVendorProductProgress';
import listNonCoaVendorOwed from '@/actions/vendors/listNonCoaVendorOwed';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
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
 * Stock Planner (waterfall model, per Ian's mock):
 * - GB Wallet splits into per-chain balances that cover Vendor GB (owed)
 *   FIRST; the wallet's excess above the owed threshold is "Crypto Profit"
 * - Floating cost payments (at-cost receivables) BACKFILL any owed the
 *   wallets can't cover — the rest sits above the threshold and joins the
 *   profit side; drawn dashed because the money hasn't arrived yet
 * - Outside crypto (attributable slice) and the entered cash-profit figure
 *   flow straight to Vendor STOCK
 * - Vendor STOCK then breaks into the planned per-product allocations and
 *   the unallocated remainder
 * - color is never the only signal: every node label carries its $ value,
 *   warnings are text badges, pending money is dashed AND labeled
 */
const KIND_COLORS: Record<string, string> = {
  root: 'rgb(24 24 27)',         // zinc-900 — the GB wallet
  wallet: 'rgb(220 38 38)',      // red-600 — wallet money bound for Vendor GB
  floating: 'rgb(234 88 12)',    // orange-600 — expected float payments
  profit: 'rgb(22 163 74)',      // green-600 — crypto profit above the owed threshold
  outside: 'rgb(13 148 136)',    // teal-600 — attributable outside crypto
  cash: 'rgb(202 138 4)',        // yellow-600 — hypothetical (entered figure)
  owed: 'rgb(37 99 235)',        // blue-600 — Vendor GB (group-buy obligations)
  pool: 'rgb(147 51 234)',       // purple-600 — Vendor STOCK budget
  alloc: 'rgb(124 58 237)',      // violet-600 — planned allocation
  ordered: 'rgb(76 29 149)',     // violet-900 — committed (vendor paid)
  rest: 'rgb(216 180 254)',      // purple-300 — unallocated remainder
};

type PlanItem = {
  id: number; group_buy_product_id: number; sku_code: string; vendor_code: string;
  kits: string; unit_cost_usd: string; freight_usd: string; planned_value_usd: string;
  ordered_at: string | null; ordered_by: string | null; ordered_value_usd: string | null;
  committed_adjustment_id: number | null; committed_at: string | null; committed_value_usd: string | null;
};
type Plan = {
  outside_total_usd: string; outside_max_usd: string; cash_assignable_usd: string;
  updated_by: string | null; updated_at: string | null; items: PlanItem[] | null;
};
type Wallet = {
  id: number; name: string; chain: string; address: string | null; active: boolean;
  latest_balance_usd: string | null; latest_snapshot_at: string | null;
};
type OwedRow = { vendor_code: string; owed_usd: string };
type Receivable = { id: number; sku_code: string; qty: string; expected_usd: string; reason: string; created_at: string; preordered: boolean };
type CampaignProduct = {
  group_buy_product_id: number; sku_code: string; vendor_code: string;
  unit_cost_usd: string; freight_usd: string; cost_tier_qty: string | null; status: string;
};
type Progress = { group_buy_product_id: number; kits_demand: string; kits_paid: string };

type SNode = { name: string; kind: string; usd: number; hint?: string };
type SLink = { source: number; target: number; value: number; kind: string };

/**
 * Waterfall Sankey (pure):
 *   GB Wallet -> per-chain balances -> Vendor GB first;
 *   wallet excess above the owed threshold -> Crypto Profit -> Vendor STOCK;
 *   floating payments backfill remaining owed, their excess -> Vendor STOCK;
 *   outside crypto + cash figure -> Vendor STOCK -> allocations + unallocated.
 */
function buildSankey(args: {
  walletRows: { name: string; usd: number }[];
  owedTotal: number; outsideMax: number; outsideTotal: number;
  receivables: number; cash: number;
  items: { label: string; usd: number; ordered: boolean }[];
}): { nodes: SNode[]; links: SLink[]; uncoveredOwed: number; overAllocated: number; pool: number; floatToOwed: number } {
  const nodes: SNode[] = [];
  const links: SLink[] = [];
  const idx = (n: SNode) => { nodes.push(n); return nodes.length - 1; };
  // ALL math in integer CENTS so every parent node equals the exact sum of
  // its child links (independent per-link rounding would let the chart's
  // totals drift from the labels/banners by pennies); dollars only at render
  const c = (usd: number) => Math.round(usd * 100);
  const usd = (cents: number) => cents / 100;

  const walletsC = args.walletRows.map(w => ({ name: w.name, c: c(w.usd) })).filter(w => w.c > 0);
  const walletTotalC = walletsC.reduce((s, w) => s + w.c, 0);
  const owedC = c(args.owedTotal);
  const receivablesC = c(args.receivables);
  const outsideC = c(args.outsideMax);
  const cashC = c(args.cash);

  // WATERFALL: wallets cover owed first…
  const walletToOwedC = Math.min(owedC, walletTotalC);
  const walletProfitC = walletTotalC - walletToOwedC; // "Crypto Profit" above the threshold
  // …then the expected float payments backfill what's left…
  const owedAfterWalletsC = owedC - walletToOwedC;
  const floatToOwedC = Math.min(receivablesC, owedAfterWalletsC);
  const floatProfitC = receivablesC - floatToOwedC;
  // …and anything still uncovered is a real gap.
  const uncoveredOwedC = Math.max(owedAfterWalletsC - floatToOwedC, 0);

  const poolC = walletProfitC + floatProfitC + outsideC + cashC;
  const itemsC = args.items.map(i => ({ ...i, c: c(i.usd) })).filter(i => i.c > 0);
  const allocTotalC = itemsC.reduce((s, i) => s + i.c, 0);
  const unallocatedC = Math.max(poolC - allocTotalC, 0);
  const overAllocatedC = Math.max(allocTotalC - poolC, 0);

  // pro-rata wallet->owed shares in cents; the LAST wallet absorbs the
  // residual pennies so the shares sum to walletToOwedC exactly
  const sharesC: number[] = [];
  let sharesSoFar = 0;
  walletsC.forEach((w, i) => {
    const share = i === walletsC.length - 1
      ? walletToOwedC - sharesSoFar
      : Math.floor(walletToOwedC * (w.c / walletTotalC));
    sharesC.push(share);
    sharesSoFar += share;
  });

  // GB Wallet root -> per-chain balances
  const rootIdx = walletTotalC > 0 ? idx({ name: 'GB Wallet', kind: 'root', usd: usd(walletTotalC) }) : -1;
  const owedIdx = owedC > 0
    ? idx({ name: 'Vendor GB', kind: 'owed', usd: usd(owedC), hint: uncoveredOwedC > 0 ? `${fmtUSD(usd(uncoveredOwedC))} not covered even with expected float payments` : floatToOwedC > 0 ? `${fmtUSD(usd(floatToOwedC))} of this coverage depends on float payments arriving` : undefined })
    : -1;
  const poolIdx = idx({ name: 'Vendor STOCK', kind: 'pool', usd: usd(poolC) });
  const profitIdx = walletProfitC > 0 ? idx({ name: 'Crypto Profit', kind: 'profit', usd: usd(walletProfitC), hint: 'wallet money above what vendors are owed' }) : -1;

  walletsC.forEach((w, i) => {
    if (rootIdx < 0) return;
    const wi = idx({ name: w.name, kind: 'wallet', usd: usd(w.c) });
    links.push({ source: rootIdx, target: wi, value: usd(w.c), kind: 'wallet' });
    const shareC = sharesC[i];
    if (shareC > 0 && owedIdx >= 0) links.push({ source: wi, target: owedIdx, value: usd(shareC), kind: 'wallet' });
    const restC = w.c - shareC;
    if (restC > 0 && profitIdx >= 0) links.push({ source: wi, target: profitIdx, value: usd(restC), kind: 'profit' });
  });
  if (profitIdx >= 0) links.push({ source: profitIdx, target: poolIdx, value: usd(walletProfitC), kind: 'profit' });

  if (receivablesC > 0) {
    const fi = idx({ name: 'Floating cost payments', kind: 'floating', usd: usd(receivablesC), hint: 'expected at-cost payments — not in the wallets yet' });
    if (floatToOwedC > 0 && owedIdx >= 0) links.push({ source: fi, target: owedIdx, value: usd(floatToOwedC), kind: 'floating' });
    if (floatProfitC > 0) links.push({ source: fi, target: poolIdx, value: usd(floatProfitC), kind: 'floating' });
  }
  if (outsideC > 0) {
    const i = idx({ name: 'Outside crypto', kind: 'outside', usd: usd(outsideC), hint: `attributable ${fmtUSD(usd(outsideC))} of ${fmtUSD(args.outsideTotal)} held` });
    links.push({ source: i, target: poolIdx, value: usd(outsideC), kind: 'outside' });
  }
  if (cashC > 0) {
    const i = idx({ name: 'Allocated cash profit', kind: 'cash', usd: usd(cashC), hint: 'entered figure — convertible cash profit, not held as crypto' });
    links.push({ source: i, target: poolIdx, value: usd(cashC), kind: 'cash' });
  }
  for (const it of itemsC) {
    const i = idx({ name: it.label, kind: it.ordered ? 'ordered' : 'alloc', usd: usd(it.c) });
    links.push({ source: poolIdx, target: i, value: usd(it.c), kind: it.ordered ? 'ordered' : 'alloc' });
  }
  if (unallocatedC > 0) {
    const i = idx({ name: 'Unallocated', kind: 'rest', usd: usd(unallocatedC) });
    links.push({ source: poolIdx, target: i, value: usd(unallocatedC), kind: 'rest' });
  }
  return {
    nodes, links,
    uncoveredOwed: usd(uncoveredOwedC),
    overAllocated: usd(overAllocatedC),
    pool: usd(poolC),
    floatToOwed: usd(floatToOwedC),
  };
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
      strokeDasharray={payload?.kind === 'cash' || payload?.kind === 'floating' ? '6 4' : undefined}
    />
  );
}

export function PlannerPage() {
  const { groupBuyId, userName, settings } = useApp();
  const enabled = groupBuyId != null;
  const [rawPlan, , , reloadPlan] = useLoadAction(getStockPlan, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawWallets, , , reloadWallets] = useLoadAction(listWallets, [], {});
  const [rawOwed] = useLoadAction(listNonCoaVendorOwed, [], {});
  const [rawRecv] = useLoadAction(listAtCostReceivables, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawProducts] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawProgress, , , reloadProgress] = useLoadAction(listVendorProductProgress, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });

  const plan = firstRow<Plan>(rawPlan);
  const wallets = rows<Wallet>(rawWallets);
  const owedRows = rows<OwedRow>(rawOwed);
  const receivables = rows<Receivable>(rawRecv);
  const products = rows<CampaignProduct>(rawProducts);
  const progress = rows<Progress>(rawProgress);
  const items: PlanItem[] = useMemo(() => plan?.items || [], [plan]);

  const [doSaveSources] = useMutateAction(saveStockPlanSources);
  const [doUpsertItem] = useMutateAction(upsertStockPlanItem);
  const [doDeleteItem] = useMutateAction(deleteStockPlanItem);
  const [doOrderItem] = useMutateAction(orderStockPlanItem);
  const [doCommitPlan] = useMutateAction(commitStockPlan);
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
  const owedRaw = owedRows.reduce((s, v) => s + Number(v.owed_usd), 0);
  // COMMITTED allocations live inside vendor owed now (their kits are real
  // demand), but this chart draws them from the stock pool on the right —
  // so net their live value back out of owed, or the same dollars would
  // count twice (once fattening Vendor GB, once as an allocation). Ordered
  // lines are excluded from the offset: their vendor payment already nets
  // them out of owed on its own.
  const committedUnorderedValue = items.reduce(
    (s, i) => s + (i.committed_adjustment_id != null && !i.ordered_at ? Number(i.planned_value_usd) : 0), 0);
  const owedTotal = Math.max(owedRaw - committedUnorderedValue, 0);
  const receivableTotal = receivables.reduce((s, r) => s + Number(r.expected_usd), 0);
  const allocatableProducts = products.filter(p =>
    p.status === 'active' && p.cost_tier_qty == null && !/^coa/i.test(p.sku_code));
  const aChosen = allocatableProducts.find(p => String(p.group_buy_product_id) === aProduct);
  const aPerKit = aChosen ? Number(aChosen.unit_cost_usd) + Number(aChosen.freight_usd) : 0;

  const walletTotal = cryptoWallets.reduce((s, w) => s + Number(w.latest_balance_usd || 0), 0);
  const allocTotal = items.reduce(
    (s, i) => s + Number(i.ordered_at ? (i.ordered_value_usd ?? i.planned_value_usd) : i.planned_value_usd), 0);
  // live what-if: the coverage gap follows the outside/cash figures AS TYPED
  // (before Save), so the operator can dial the inputs until the allocations
  // are covered. Same waterfall as buildSankey, in integer cents; invalid or
  // negative input counts as 0 rather than poisoning the number with NaN,
  // and attributable is capped at what the outside wallet holds — the same
  // constraint Save enforces, so the box never shows "covered" on a figure
  // that could not be saved.
  const liveShortfall = useMemo(() => {
    const c = (n: number) => Math.round(n * 100);
    const num = (s: string) => { const n = Number(s); return Number.isFinite(n) && n > 0 ? n : 0; };
    const walletC = c(walletTotal);
    const owedC = c(owedTotal);
    const recvC = c(receivableTotal);
    const walletProfitC = Math.max(walletC - owedC, 0);
    const floatProfitC = recvC - Math.min(recvC, Math.max(owedC - walletC, 0));
    const outsideC = Math.min(c(num(srcOutsideMax)), c(num(srcOutsideTotal)));
    const poolC = walletProfitC + floatProfitC + outsideC + c(num(srcCash));
    return (c(allocTotal) - poolC) / 100;
  }, [walletTotal, owedTotal, receivableTotal, srcOutsideMax, srcOutsideTotal, srcCash, allocTotal]);

  const sankey = useMemo(() => buildSankey({
    walletRows: cryptoWallets.map(w => ({ name: w.name, usd: Number(w.latest_balance_usd || 0) })),
    owedTotal,
    outsideMax: Number(plan?.outside_max_usd || 0),
    outsideTotal: Number(plan?.outside_total_usd || 0),
    receivables: receivableTotal,
    cash: Number(plan?.cash_assignable_usd || 0),
    items: items.map(i => ({
      label: `${i.sku_code} × ${fmtNum(i.kits)}${i.ordered_at ? ' (ordered)' : i.committed_adjustment_id != null ? ' (committed)' : ''}`,
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
      setAMsg('Not saved — the product must be active, flat-cost, in this campaign, and the line not already committed or ordered.');
      return;
    }
    setAProduct(''); setAKits('');
    reloadPlan();
  };

  const removeAllocation = async (it: PlanItem) => {
    // 6px from "Mark ordered" on a phone — a mis-tap must not silently
    // delete a plan line (mobile audit item 7)
    if (!window.confirm('Remove this plan allocation?')) return;
    const res = await doDeleteItem({ item_id: it.id, group_buy_id: groupBuyId, actor: userName }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) { setAMsg('Not removed — an ordered line is locked to its vendor payment, and a committed line is locked to its adjustment (remove it on Products first).'); return; }
    reloadPlan();
  };

  const uncommitted = items.filter(i => i.committed_adjustment_id == null);
  const uncommittedValue = uncommitted.reduce((s, i) => s + Number(i.planned_value_usd), 0);
  const [committing, setCommitting] = useState(false);

  const commitPlan = async () => {
    if (uncommitted.length === 0) return;
    // a line whose product has NO group demand yet is this product's FIRST
    // demand — committing it also starts the product's one-time testing
    // cost in P&L (real money the commit decision incurs), so say so
    const firstDemand = (i: PlanItem) => {
      const prog = progress.find(p => Number(p.group_buy_product_id) === Number(i.group_buy_product_id));
      return !prog || Number(prog.kits_demand) <= 0;
    };
    const lines = uncommitted.map(i =>
      `  ${i.sku_code} × ${fmtNum(i.kits)} = ${fmtUSD(i.planned_value_usd)}${firstDemand(i) ? '  ⚠ FIRST demand — its one-time testing cost will also hit P&L' : ''}`).join('\n');
    if (!window.confirm(
      `Commit the ENTIRE plan to vendor demand?\n\n${lines}\n\nTotal ${fmtUSD(uncommittedValue)} at vendor cost + freight.\n\nThese kits are added to what we order from the vendors, and the total comes out of NET PROFIT before the split. No receivable — this is the group's own stock. All-or-nothing: if any line's product is inactive or tiered, nothing commits.`)) {
      return;
    }
    setCommitting(true); setAMsg('');
    try {
      // the commit is anchored to EXACTLY the lines just confirmed —
      // if the plan changed meanwhile (co-admin edit), the server
      // refuses the whole batch and we re-confirm against fresh data
      const res = await doCommitPlan({
        group_buy_id: groupBuyId, actor: userName,
        confirmed_items: uncommitted.map(i => `${i.id}:${Number(i.kits)}`).join(','),
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
        setAMsg('Nothing committed — the plan changed while you were confirming (or every line is already committed, or a product is inactive/tiered). Refresh and try again.');
        reloadPlan();
        return;
      }
      reloadPlan(); reloadProgress();
    } finally {
      setCommitting(false);
    }
  };

  const openOrderDialog = (it: PlanItem) => {
    setOrdering(it); setODate(''); setOWallet(''); setOMethod('USDC'); setORef(''); setOMsg('');
  };

  const commitOrder = async () => {
    if (!ordering) return;
    if (!oDate) { setOMsg('Date is required.'); return; }
    if (!oWallet) { setOMsg('Pick the wallet the payment came from.'); return; }
    const kits = Number(ordering.kits);
    const prog = progress.find(p => Number(p.group_buy_product_id) === Number(ordering.group_buy_product_id));
    const kitsOwed = prog ? Math.round((Number(prog.kits_demand) - Number(prog.kits_paid)) * 100) / 100 : 0;
    const over = kits > kitsOwed;
    if (over && !window.confirm(
      `${ordering.sku_code}: this pays for ${fmtNum(kits)} kits but only ${fmtNum(Math.max(kitsOwed, 0))} are still owed by demand — the rest is deliberate personal stock (over-buy).\n\nRecord anyway?`)) {
      return;
    }
    setOSaving(true); setOMsg('');
    try {
      // ONE atomic server action: the vendor payment and the plan stamp
      // commit together (the amount is computed server-side from the plan
      // line) — a retry or concurrent click sees the row locked/ordered and
      // refuses BEFORE any payment is inserted
      const res = await doOrderItem({
        item_id: ordering.id, group_buy_id: groupBuyId, paid_on: oDate,
        wallet_id: oWallet, method: oMethod, receipt_ref: oRef.trim(),
        allow_over: over ? 'true' : '', confirmed_owed: over ? String(Math.max(kitsOwed, 0)) : '',
        actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
        setOMsg('Not recorded — the line is already ordered, or owed changed while confirming (someone else recorded a payment?). Refresh and retry.');
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
        <h1 className="text-2xl font-bold flex items-center gap-2 text-gradient">
          <GitBranch className="h-6 w-6 text-cyan-300" /> Stock Planner
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          What the wallets hold, what vendors are owed, and how the rest distributes into personal-stock orders (valued at vendor cost + freight). The plan is saved and shared.
        </p>
      </div>

      {sankey.uncoveredOwed > 0 && (
        <div className="rounded border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span>Vendor GB is short <span className="font-semibold">{fmtUSD(sankey.uncoveredOwed)}</span> even counting the expected float payments — cover the gap before allocating stock.</span>
        </div>
      )}
      {sankey.uncoveredOwed <= 0 && sankey.floatToOwed > 0 && (
        <div className="rounded border border-amber-400/40 bg-amber-400/5 p-3 text-sm text-amber-200 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span><span className="font-semibold">{fmtUSD(sankey.floatToOwed)}</span> of the Vendor GB coverage depends on float payments that haven't arrived yet (dashed flow).</span>
        </div>
      )}
      {sankey.overAllocated > 0 && (
        <div className="rounded border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span>Over-allocated by <span className="font-semibold">{fmtUSD(sankey.overAllocated)}</span> — planned purchases exceed the Vendor STOCK budget ({fmtUSD(sankey.pool)}).</span>
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
          {refreshMsg && <p className="text-xs text-rose-400 mb-2">{refreshMsg}</p>}
          {sankey.links.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Nothing to draw yet — refresh wallet balances or enter sources below.</p>
          ) : (
            // the flow diagram needs real width for its four columns and
            // outboard labels — on narrow screens it keeps a minimum width
            // and scrolls horizontally instead of squashing
            <div className="w-full overflow-x-auto">
              <div style={{ minWidth: 760, height: 440 }}>
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
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            Waterfall: the wallets cover Vendor GB first; float payments backfill the rest of owed, and everything above that threshold flows to Vendor STOCK. Dashed flows are money not in the wallets yet. The stock budget mixes sources — no specific dollar funds a specific kit.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Sources</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="space-y-1">
              {cryptoWallets.map(w => (
                <div key={w.id} className="flex justify-between gap-2">
                  <span className="text-muted-foreground min-w-0 truncate">{w.name} ({w.chain})</span>
                  <span className="shrink-0 text-right">
                    {fmtUSD(w.latest_balance_usd || 0)}
                    {w.latest_snapshot_at && <span className="block text-[10px] text-muted-foreground">as of {fmtDateTime(w.latest_snapshot_at)}</span>}
                  </span>
                </div>
              ))}
              <div className="flex justify-between gap-2 border-t pt-1 font-medium">
                <span className="min-w-0">Total wallet value</span>
                <span className="shrink-0 whitespace-nowrap">{fmtUSD(walletTotal)}</span>
              </div>
              <div className="flex justify-between gap-2 border-t pt-1">
                <span className="text-muted-foreground min-w-0">Owed to vendors (non-COA, all campaigns)</span>
                <span className="text-rose-400 shrink-0 whitespace-nowrap">−{fmtUSD(owedTotal)}</span>
              </div>
              {committedUnorderedValue > 0 && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground min-w-0 text-xs">…excludes {fmtUSD(committedUnorderedValue)} of committed stock, shown below as allocations</span>
                </div>
              )}
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground min-w-0">Expected at-cost payments ({receivables.length})</span>
                <span className="text-amber-300 shrink-0 whitespace-nowrap">{fmtUSD(receivableTotal)}</span>
              </div>
            </div>
            <div className="border-t pt-2 space-y-2">
              <div className="flex flex-wrap gap-x-6 gap-y-2 items-start">
                <div className="space-y-2">
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
                </div>
                {/* coverage gap for the planned stock, LIVE against the
                    figures typed on the left (not just the saved plan) */}
                <div className={`flex-1 min-w-44 rounded border p-2 text-xs ${
                  allocTotal <= 0 ? 'border-border text-muted-foreground'
                    : liveShortfall > 0 ? 'border-rose-400/40 bg-rose-400/10 text-rose-300'
                      : 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'}`}>
                  <p className="font-semibold uppercase text-[10px]">Stock allocations · {fmtUSD(allocTotal)}</p>
                  {allocTotal <= 0 ? (
                    <p className="mt-0.5">No stock allocated yet.</p>
                  ) : liveShortfall > 0 ? (
                    <p className="mt-0.5">Need <span className="font-semibold">{fmtUSD(liveShortfall)}</span> more to cover.</p>
                  ) : (
                    <p className="mt-0.5">Covered — {fmtUSD(-liveShortfall)} to spare.</p>
                  )}
                  <p className="text-[10px] opacity-80 mt-0.5">Updates as you type the outside / cash figures.</p>
                </div>
              </div>
              <Button size="sm" className="h-8" onClick={saveSources}>Save sources</Button>
              {srcMsg && <p className="text-xs text-rose-400">{srcMsg}</p>}
              {plan?.updated_by && <p className="text-[11px] text-muted-foreground">Last saved by {plan.updated_by} {plan.updated_at ? fmtDateTime(plan.updated_at) : ''}</p>}
            </div>
            {receivables.length > 0 && (
              <div className="border-t pt-2">
                <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Awaiting at-cost payments</p>
                {receivables.map(r => (
                  <div key={r.id} className="flex justify-between gap-2 text-xs">
                    <span className="text-muted-foreground min-w-0 truncate" title={`${r.sku_code} × ${fmtNum(r.qty)}${r.preordered ? ' (already ordered)' : ''} — ${r.reason}`}>
                      {r.sku_code} × {fmtNum(r.qty)}{r.preordered && <span className="text-sky-300"> (ordered)</span>} — {r.reason}
                    </span>
                    <span className="text-amber-300 shrink-0 whitespace-nowrap">{fmtUSD(r.expected_usd)}</span>
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
            {aMsg && <p className="text-xs text-rose-400">{aMsg}</p>}
            <div className="space-y-1 pt-1">
              {items.map(it => (
                <div key={it.id} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b last:border-0 pb-1">
                  <span className="min-w-0 flex-1 truncate">
                    {it.sku_code} × {fmtNum(it.kits)}
                    <span className="text-muted-foreground"> · {it.vendor_code}</span>
                    {it.ordered_at && (
                      <span className="ml-1.5 rounded bg-violet-400/10 text-violet-300 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                        title={`Vendor payment recorded ${fmtDateTime(it.ordered_at)} by ${it.ordered_by}`}>ordered</span>
                    )}
                    {!it.ordered_at && it.committed_adjustment_id != null && (
                      <span className="ml-1.5 rounded bg-emerald-400/10 text-emerald-300 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                        title={`In vendor demand since ${it.committed_at ? fmtDateTime(it.committed_at) : ''} — ${fmtUSD(it.committed_value_usd || 0)} pulls from net profit pre-split`}>committed</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0 whitespace-nowrap ml-auto">
                    {fmtUSD(it.ordered_at ? (it.ordered_value_usd ?? it.planned_value_usd) : it.planned_value_usd)}
                    {!it.ordered_at && (
                      <>
                        <Button size="sm" variant="outline" className="h-8 px-2 text-[11px]" onClick={() => openOrderDialog(it)}>Mark ordered</Button>
                        {/* a committed line's kits live in an adjustment now —
                            removing it goes through Products, not here */}
                        {it.committed_adjustment_id == null && (
                          <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-xs text-rose-400" onClick={() => removeAllocation(it)}>✕</Button>
                        )}
                      </>
                    )}
                  </span>
                </div>
              ))}
              {items.length === 0 && <p className="text-xs text-muted-foreground">No allocations yet — pick a product above.</p>}
            </div>
            {uncommitted.length > 0 && (
              <div className="border-t pt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" className="h-8 bg-emerald-700 hover:bg-emerald-800" disabled={committing} onClick={commitPlan}>
                  {committing ? 'Committing…' : `Commit plan — ${uncommitted.length} ${uncommitted.length === 1 ? 'line' : 'lines'}, ${fmtUSD(uncommittedValue)}`}
                </Button>
                <span className="text-[11px] text-muted-foreground min-w-0">
                  Adds the kits to what we order from vendors, at cost + freight, out of net profit pre-split.
                </span>
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              "Mark ordered" records the REAL vendor payment (same guarded path as the Vendors page, over-buy confirm included) and locks the line.
              To add MORE of a committed product, add a "Both (group stock)" adjustment on the Products page — same economics, no plan line needed.
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
              {oMsg && <p className="text-xs text-rose-400">{oMsg}</p>}
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
