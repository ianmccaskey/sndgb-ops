import React from 'react';
import { fmtUSD, fmtNum, fmtDate } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { equalPct, equalShares, partyPayouts } from '@/lib/payout';

/*
 * Profit dispersion: the full story of where profit comes from and where it
 * goes, with per-party stock-contribution tracking. The spine is an EXACT
 * composition (agreed definitions):
 *
 *   earned_margin = product_profit − (stock_retail − stock_cost)
 *   GROSS         = earned_margin + admin_fees + tips + split_fees
 *   shipping_net  = shipping_fees + insurance − label_costs − ship/reship expenses
 *   NET           = GROSS − other expenses − comps − credits
 *                   − write-offs − GB-price giveaways − at-cost margin waived
 *                   − direct freight − group stock (at cost+freight)
 *
 * shipping_net is the SHIPPING POT and is NOT part of NET (policy,
 * 2026-10-17 — "those are used to cover shipping expenses"): the view's
 * net_profit_usd excludes the pot's revenue AND its costs, and this tab
 * shows the pot in its own card instead of the bridge.
 *
 * NET is an algebraic identity with v_group_buy_pnl.net_profit_usd (the
 * stock_retail/stock_cost terms cancel exactly) — verified against live
 * data, and re-checked at render: any drift ≥ 1¢ shows a red banner
 * instead of silently lying.
 *
 * PAYOUTS (src/lib/payout.ts, policy 2026-10-24): group stock sits inside
 * NET but is NOT borne by the profit split — the partners fund it equally
 * (50/50 with two parties). A party gets pct × (NET + group stock), minus
 * an equal share of group stock, minus personal deductions. The ledgers
 * below show those three steps; the parties still sum to NET − personal.
 */

export type Pnl = {
  product_revenue_usd: string; order_count: string; admin_fee_revenue_usd: string;
  shipping_fee_revenue_usd: string; insurance_revenue_usd: string; tip_revenue_usd: string; total_revenue_usd: string;
  product_profit_usd: string; expenses_usd: string; label_costs_usd: string; net_profit_usd: string;
  direct_freight_usd: string; split_fees_usd: string; at_cost_margin_usd: string;
  stock_cost_usd: string; stock_retail_usd: string;
  /** group stock of OTHER items (not campaign products, 1790102300): cost only, out of net */
  other_stock_usd: string;
  comps_usd: string; credits_usd: string; writeoffs_usd: string; adj_both_usd: string;
  shipping_expenses_usd: string;
  shipping_net_usd: string;
  adjustments: { beneficiary: string; value_usd: string; count: string }[] | null;
  splits: { party: string; pct: string }[] | null;
};

export type DispAdjustment = {
  id: number; sku_code: string; qty: string; reason: string; created_at: string;
  beneficiary: string; pricing: string; expected_usd: string | null;
  preordered: boolean; stock: boolean; stock_plan_item_id: number | null; value_usd: string;
};

type ExpenseRow = { category: string; total_usd: string };

const num = (v: string | number | null | undefined) => Number(v || 0);

export function DispersionTab({ pnl, expenses, adjustments, adjustmentsState }: {
  pnl: Pnl | undefined;
  expenses: ExpenseRow[];
  adjustments: DispAdjustment[];
  // the itemized rows load lazily on tab activation — until they land, the
  // itemized sections show a loading note and the per-party desync guard
  // stays silent (an empty list is "not loaded yet", not "out of sync");
  // a FAILED load renders as failure, never as an empty dataset
  adjustmentsState: 'loading' | 'error' | 'ready';
}) {
  const adjustmentsReady = adjustmentsState === 'ready';
  const itemizedNote = adjustmentsState === 'error'
    ? 'Failed to load the itemized adjustments — the totals above are unaffected. Switch tabs and back to retry.'
    : 'Loading itemized adjustments…';
  const itemizedNoteClass = adjustmentsState === 'error' ? 'text-xs text-rose-400' : 'text-xs text-muted-foreground';
  const splits = pnl?.splits || [];
  const viewNet = num(pnl?.net_profit_usd);

  // ---- exact composition -------------------------------------------------
  const earnedMargin = num(pnl?.product_profit_usd) - (num(pnl?.stock_retail_usd) - num(pnl?.stock_cost_usd));
  const gross = earnedMargin + num(pnl?.admin_fee_revenue_usd) + num(pnl?.tip_revenue_usd) + num(pnl?.split_fees_usd);

  // the shipping slice comes from getPnl's OWN statement (same snapshot as
  // the view totals), never from the separately-loaded expense list — a
  // stale list can therefore only affect display sub-rows (guarded below),
  // never the bridge math
  const shipExp = num(pnl?.shipping_expenses_usd);
  const otherExp = num(pnl?.expenses_usd) - shipExp;
  const shippingNet = num(pnl?.shipping_fee_revenue_usd) + num(pnl?.insurance_revenue_usd) - num(pnl?.label_costs_usd) - shipExp;
  const shipExpFromList = expenses
    .filter(e => e.category === 'shipping' || e.category === 'reship')
    .reduce((s, e) => s + num(e.total_usd), 0);

  // the shipping POT — rendered in its own card, never a bridge line:
  // net profit excludes it by policy (see the header comment)
  const potRows = [
    { label: 'Shipping fees collected', amount: num(pnl?.shipping_fee_revenue_usd) },
    { label: 'Shipping insurance collected', amount: num(pnl?.insurance_revenue_usd) },
    { label: 'Label costs (from shipments)', amount: -num(pnl?.label_costs_usd) },
    { label: 'Shipping / reship expenses', amount: -shipExp },
  ];
  // the on-screen expense list disagreeing with the P&L snapshot means
  // it's stale — rendered as an amber WARNING under the pot, never as a
  // money row a scanner could read as a real cost line
  const potListStale = Math.abs(shipExpFromList - shipExp) >= 0.005;

  const bridge: { label: string; amount: number; hint?: string; subs?: { label: string; amount: number }[] }[] = [
    {
      label: 'Expenses (non-shipping)', amount: -otherExp,
      // category sub-rows are DERIVED from the expense list, never a
      // hard-coded name set — a new category can't silently vanish from
      // the breakdown; any residue vs the view total gets its own row
      subs: (() => {
        const cats = [...new Set(expenses.map(e => e.category))].filter(c => c !== 'shipping' && c !== 'reship').sort();
        const subs = cats.map(cat => ({
          label: cat,
          amount: -expenses.filter(e => e.category === cat).reduce((s, e) => s + num(e.total_usd), 0),
        })).filter(s => s.amount !== 0);
        const listed = subs.reduce((s, x) => s + x.amount, 0);
        const remainder = -otherExp - listed;
        if (Math.abs(remainder) >= 0.005) subs.push({ label: 'not in the expense list (view/list desync?)', amount: remainder });
        return subs;
      })(),
    },
    { label: 'Comped product (free to customers)', amount: -num(pnl?.comps_usd) },
    { label: 'Customer credits', amount: -num(pnl?.credits_usd) },
    { label: 'Write-offs (forgiven shortfalls)', amount: -num(pnl?.writeoffs_usd) },
    { label: 'Giveaways at GB price (adjustments for both)', amount: -num(pnl?.adj_both_usd) },
    { label: 'At-cost sales (margin waived)', amount: -num(pnl?.at_cost_margin_usd), hint: 'Outside-customer sales at vendor cost + freight — the margin they would have earned is waived so the sale nets zero' },
    { label: 'Direct-ship freight (internal, to vendors)', amount: -num(pnl?.direct_freight_usd) },
    { label: 'Group stock (at cost + freight)', amount: -num(pnl?.stock_cost_usd), hint: `Stock-plan commits and group-stock adjustments — the group buys its own kits out of profit. Funded EQUALLY by the partners (${equalPct(splits)}% each), not by the profit split — see the payout ledgers` },
    { label: 'Group stock — other items (at cost)', amount: -num(pnl?.other_stock_usd), hint: `Items that are not campaign products, bought from a vendor for the group at a typed cost. Funded EQUALLY by the partners (${equalPct(splits)}% each) like every group-stock row` },
  ];
  // group stock the partners fund equally: campaign-product rows AND
  // other-item rows (1790102300)
  const stockCost = num(pnl?.stock_cost_usd) + num(pnl?.other_stock_usd);
  const composedNet = gross + bridge.reduce((s, b) => s + b.amount, 0);
  const drift = Math.abs(composedNet - viewNet) >= 0.005;

  // informational per-party figure (Ian's ask, updated with the pot
  // policy): net after ONLY comps, credits, write-offs, and GB-price
  // giveaways — the shipping pot (no longer profit at all), stock
  // (group AND personal), at-cost waivers, direct freight, and
  // non-shipping expenses deliberately excluded. Not a payout figure.
  const infoNet = gross
    - num(pnl?.comps_usd) - num(pnl?.credits_usd) - num(pnl?.writeoffs_usd) - num(pnl?.adj_both_usd);

  // ---- per-party stock contributions --------------------------------------
  // group-stock rows (planner commits + direct) are funded EQUALLY by the
  // split parties (50/50 today — src/lib/payout.ts); personal rows belong
  // 100% to their party
  const stockRows = adjustments
    .filter(a => a.stock || (a.pricing === 'cost' && a.beneficiary !== 'both' && a.beneficiary !== 'unattributed'))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const rowValue = (a: DispAdjustment) => num(a.expected_usd);
  // a personal row whose beneficiary no longer matches a split party
  // (rename/removal drift) must not silently show zero in every column —
  // it gets an explicit Orphaned column so table totals always reconcile
  const isOrphaned = (a: DispAdjustment) => !a.stock && !splits.some(s => s.party === a.beneficiary);
  const hasOrphans = stockRows.some(isOrphaned);
  // group-stock row shares use CUMULATIVE rounding: a row's share is the
  // equal split of the running total up to and including it, minus the
  // split up to the row before. Splitting each row on its own would hand
  // every odd cent to the last party, and the table's column totals would
  // drift from the ledgers' single equalShares(stockCost) by a cent per
  // odd-cent row (Codex, 2026-10-24); this way the columns sum to exactly
  // what the ledgers deduct.
  const stockRowShares = new Map<number, Record<string, number>>();
  {
    let runningStock = 0;
    for (const a of stockRows) {
      if (!a.stock) continue;
      const before = equalShares(runningStock, splits);
      runningStock = Math.round((runningStock + rowValue(a)) * 100) / 100;
      const after = equalShares(runningStock, splits);
      stockRowShares.set(a.id, Object.fromEntries(splits.map(s =>
        [s.party, Math.round(((after[s.party] || 0) - (before[s.party] || 0)) * 100) / 100])));
    }
  }
  const rowShares = (a: DispAdjustment): Record<string, number> => {
    if (a.stock) return stockRowShares.get(a.id) || equalShares(rowValue(a), splits);
    return Object.fromEntries(splits.map(s => [s.party, s.party === a.beneficiary ? rowValue(a) : 0]));
  };
  const orphanedTotal = stockRows.filter(isOrphaned).reduce((s, a) => s + rowValue(a), 0);
  const contribTotals: Record<string, { group: number; personal: number }> = {};
  for (const s of splits) contribTotals[s.party] = { group: 0, personal: 0 };
  for (const a of stockRows) {
    const shares = rowShares(a);
    for (const s of splits) {
      if (!contribTotals[s.party]) continue;
      if (a.stock) contribTotals[s.party].group += shares[s.party] || 0;
      else contribTotals[s.party].personal += shares[s.party] || 0;
    }
  }

  // personal payout deductions (gb-priced personal at GB value, at-cost
  // personal at snapshot) come from getPnl's per-beneficiary aggregation —
  // the same figures the Overview split lines use
  const personalDeduction = (party: string) =>
    num((pnl?.adjustments || []).find(a => a.beneficiary === party)?.value_usd);
  const unattributed = (pnl?.adjustments || []).filter(a =>
    a.beneficiary !== 'both' && num(a.value_usd) !== 0 && !splits.some(s => s.party === a.beneficiary));

  const personalItems = (party: string) => adjustments.filter(a =>
    a.beneficiary === party && (a.pricing === 'gb' || a.pricing === 'cost'));

  // the ONE payout computation every party figure on this tab reads from
  const payouts = partyPayouts(viewNet, stockCost, splits, personalDeduction);

  let running = gross;

  return (
    <div className="space-y-5">
      {drift && (
        <div className="rounded border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-300">
          Composition drift: these lines sum to {fmtUSD(composedNet)} but the P&L view says {fmtUSD(viewNet)}.
          A new P&L component exists that this tab does not know about — trust the Overview number and report this.
        </div>
      )}

      {/* header band, per the mock: big gross / net + per-party boxes */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm font-bold uppercase tracking-wide underline underline-offset-4">Gross profit</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <div className="text-3xl font-bold text-blue-300">{fmtUSD(gross)}</div>
            <div className="text-xs text-muted-foreground space-y-0.5 pt-1">
              <div className="flex justify-between"><span>Product margin (earned)</span><span>{fmtUSD(earnedMargin)}</span></div>
              <div className="flex justify-between"><span>Admin fees ({num(pnl?.order_count)} orders)</span><span>{fmtUSD(pnl?.admin_fee_revenue_usd)}</span></div>
              <div className="flex justify-between"><span>Tips</span><span>{fmtUSD(pnl?.tip_revenue_usd)}</span></div>
              <div className="flex justify-between"><span>Split kit fees</span><span>{fmtUSD(pnl?.split_fees_usd)}</span></div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1"><CardTitle className="text-sm font-bold uppercase tracking-wide">Net profit</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            <div className="text-3xl font-bold text-blue-300">{fmtUSD(viewNet)}</div>
            <div className="text-xs text-muted-foreground space-y-0.5 pt-1">
              {bridge.filter(b => b.amount !== 0).slice(0, 4).map(b => (
                <div key={b.label} className="flex justify-between">
                  <span className="truncate pr-2">{b.label}</span>
                  <span className={b.amount < 0 ? 'text-rose-400' : 'text-emerald-300'}>{b.amount < 0 ? '−' : '+'}{fmtUSD(Math.abs(b.amount))}</span>
                </div>
              ))}
              <div className="text-[10px]">full bridge below</div>
            </div>
          </CardContent>
        </Card>
        <div className="space-y-3">
          <div className="text-sm font-bold uppercase tracking-wide px-1">Net profit break</div>
          {splits.map(s => (
            <Card key={s.party}>
              <CardContent className="py-3 space-y-0.5">
                <div className="flex items-baseline justify-between gap-2"
                  title={`${Number(s.pct)}% of net before group stock (${fmtUSD(viewNet + stockCost)}) = ${fmtUSD(payouts[s.party]?.base || 0)}, minus an equal ${equalPct(splits)}% share of group stock (${fmtUSD(payouts[s.party]?.stockShare || 0)})`}>
                  <span className="text-xl font-bold">{s.party}</span>
                  <span className="text-2xl font-bold text-emerald-300 whitespace-nowrap">{fmtUSD(payouts[s.party]?.beforePersonal || 0)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground"
                  title="Informational only: gross − comps − credits − write-offs − GB-price giveaways, × split share. The shipping pot (not profit by policy), stock (group and personal), at-cost waivers, direct freight, and non-shipping expenses are deliberately excluded — this is not a payout figure.">
                  <span>after comp/credit/WO/giveaway</span>
                  <span className="whitespace-nowrap">{fmtUSD(infoNet * Number(s.pct) / 100)}</span>
                </div>
              </CardContent>
            </Card>
          ))}
          <p className="text-[10px] text-muted-foreground px-1">Split share of net before group stock, minus an equal share of group stock ({equalPct(splits)}% each), before personal deductions — final payouts below.</p>
        </div>
      </div>

      {/* gross -> net bridge, every deduction visible with a running total */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Gross → Net bridge</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Running</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="font-semibold">
                <TableCell>Gross profit</TableCell>
                <TableCell className="text-right">{fmtUSD(gross)}</TableCell>
                <TableCell className="text-right">{fmtUSD(gross)}</TableCell>
              </TableRow>
              {bridge.map(b => {
                if (b.amount === 0 && !(b.subs || []).some(s => s.amount !== 0)) return null;
                running += b.amount;
                const rowRunning = running;
                return (
                  <React.Fragment key={b.label}>
                    <TableRow>
                      <TableCell title={b.hint}>{b.label}</TableCell>
                      <TableCell className={`text-right ${b.amount < 0 ? 'text-rose-400' : 'text-emerald-300'}`}>
                        {b.amount < 0 ? '−' : '+'}{fmtUSD(Math.abs(b.amount))}
                      </TableCell>
                      <TableCell className="text-right">{fmtUSD(rowRunning)}</TableCell>
                    </TableRow>
                    {(b.subs || []).filter(s => s.amount !== 0).map(sub => (
                      <TableRow key={`${b.label}:${sub.label}`} className="bg-muted/30 hover:bg-muted/40">
                        <TableCell className="pl-8 text-xs text-muted-foreground">↳ {sub.label}</TableCell>
                        <TableCell className={`text-right text-xs ${sub.amount < 0 ? 'text-rose-400' : 'text-emerald-300'}`}>
                          {sub.amount < 0 ? '−' : '+'}{fmtUSD(Math.abs(sub.amount))}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    ))}
                  </React.Fragment>
                );
              })}
              <TableRow className="font-semibold border-t-2">
                <TableCell>Net profit</TableCell>
                <TableCell />
                <TableCell className={`text-right ${viewNet >= 0 ? 'text-emerald-300' : 'text-rose-400'}`}>{fmtUSD(viewNet)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* the shipping pot — outside the bridge because it is outside net
          profit: earmarked money, its own books */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base"
            title="Shipping fees and insurance are collected to pay for shipping. Both the money in and the costs it covers are excluded from net profit — a surplus is the planner's shipping reserve; a deficit is NOT absorbed by profit and shows amber.">
            Shipping pot — covers shipping, not profit
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-sm space-y-1 max-w-md">
            {potRows.filter(r => r.amount !== 0).map(r => (
              <div key={r.label} className="flex justify-between">
                <span className="text-muted-foreground">{r.label}</span>
                <span className={r.amount < 0 ? 'text-rose-400' : ''}>{r.amount < 0 ? '−' : ''}{fmtUSD(Math.abs(r.amount))}</span>
              </div>
            ))}
            <div className="flex justify-between font-medium border-t pt-1">
              <span>{shippingNet >= 0 ? 'Pot surplus (shipping reserve)' : 'Pot deficit — shipping cost more than was collected'}</span>
              <span className={shippingNet >= 0 ? '' : 'text-amber-300'}>{shippingNet >= 0 ? '+' : '−'}{fmtUSD(Math.abs(shippingNet))}</span>
            </div>
            {potListStale && (
              <p className="text-xs text-amber-300">
                Expense list is stale vs the P&L snapshot ({shipExp - shipExpFromList >= 0 ? '+' : '−'}{fmtUSD(Math.abs(shipExp - shipExpFromList))}) — reload. The pot total above is authoritative.
              </p>
            )}
            {Math.abs(shippingNet - num(pnl?.shipping_net_usd)) >= 0.005 && (
              <p className="text-xs text-rose-400">
                Pot drift: these lines sum to {shippingNet >= 0 ? '' : '−'}{fmtUSD(Math.abs(shippingNet))} but the P&L view says {num(pnl?.shipping_net_usd) >= 0 ? '' : '−'}{fmtUSD(Math.abs(num(pnl?.shipping_net_usd)))} — trust the view; this is a bug in this page's math.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {unattributed.length > 0 && (
        <div className="rounded border border-amber-400/40 bg-amber-400/5 p-2 text-xs text-amber-200">
          <span className="font-semibold">Unattributed adjustments:</span>{' '}
          {unattributed.map(a => `${a.beneficiary} (${fmtUSD(a.value_usd)})`).join(', ')}
          {' '}— no current split party matches, so this value is deducted from NO ONE's payout. Reassign on the Products page.
        </div>
      )}

      {/* per-party ledgers: base share -> personal deductions -> final payout */}
      <div className="grid gap-4 lg:grid-cols-2">
        {splits.map(s => {
          const pay = payouts[s.party];
          const personal = pay.personal;
          const items = personalItems(s.party);
          const itemsSum = items.reduce((sum, a) => sum + (a.pricing === 'cost' ? num(a.expected_usd) : num(a.value_usd)), 0);
          // the payout total comes from the P&L view's aggregation, the
          // itemized rows from a separately-loaded list — if they ever
          // disagree (concurrent edit between loads), say so loudly rather
          // than looking reconciled while showing stale line items
          const desync = adjustmentsReady && Math.abs(itemsSum - personal) >= 0.005;
          return (
            <Card key={s.party}>
              <CardHeader className="pb-2"><CardTitle className="text-base">{s.party} — payout ledger</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                <div className="flex justify-between"
                  title="Net profit with group stock added back — the split applies to profit BEFORE the group bought its stock">
                  <span className="text-muted-foreground">Net share before group stock ({Number(s.pct)}% of {fmtUSD(viewNet + stockCost)})</span><span>{fmtUSD(pay.base)}</span>
                </div>
                {stockCost !== 0 && (
                  <div className="flex justify-between"
                    title={`Group stock is funded equally by the ${splits.length} partners, not by the profit split — ${equalPct(splits)}% of ${fmtUSD(stockCost)}`}>
                    <span className="text-muted-foreground">Group stock, equal share ({equalPct(splits)}% of {fmtUSD(stockCost)})</span>
                    <span className="text-rose-400">−{fmtUSD(pay.stockShare)}</span>
                  </div>
                )}
                {!adjustmentsReady && <p className={itemizedNoteClass}>{itemizedNote}</p>}
                {desync && (
                  <div className="rounded border border-amber-400/40 bg-amber-400/5 p-2 text-xs text-amber-200">
                    Itemized rows sum to {fmtUSD(itemsSum)} but the P&L aggregation says {fmtUSD(personal)} — the two
                    loads are out of sync (something changed between them). The final payout below uses the P&L figure; reload the page to re-sync the detail.
                  </div>
                )}
                {adjustmentsReady && items.map(a => {
                  const v = a.pricing === 'cost' ? num(a.expected_usd) : num(a.value_usd);
                  return (
                    <div key={a.id} className="flex justify-between">
                      <span className="text-muted-foreground min-w-0 truncate pr-2">
                        {a.sku_code} × {fmtNum(a.qty)} {a.pricing === 'cost' ? '(personal stock, at cost + freight)' : '(at GB price)'}
                      </span>
                      <span className={v > 0 ? 'text-rose-400' : 'text-emerald-300'}>{v > 0 ? '−' : '+'}{fmtUSD(Math.abs(v))}</span>
                    </div>
                  );
                })}
                <div className="flex justify-between font-semibold border-t pt-1">
                  <span>Final payout</span>
                  <span className={pay.payout >= 0 ? 'text-emerald-300' : 'text-rose-400'}>{fmtUSD(pay.payout)}</span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* contribution running totals: how much each party has put into stock */}
      <div className="grid gap-4 lg:grid-cols-2">
        {splits.map(s => {
          const t = contribTotals[s.party] || { group: 0, personal: 0 };
          const base = payouts[s.party]?.base || 0;
          return (
            <Card key={s.party}>
              <CardHeader className="pb-2"><CardTitle className="text-base">{s.party} — stock contributions</CardTitle></CardHeader>
              <CardContent className="text-sm space-y-1">
                {!adjustmentsReady && <p className={itemizedNoteClass}>{itemizedNote}</p>}
                <div className="flex justify-between"><span className="text-muted-foreground">Group stock ({equalPct(splits)}% of {fmtUSD(stockCost)}, equal share)</span><span>{fmtUSD(t.group)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Personal stock (at cost + freight)</span><span>{fmtUSD(t.personal)}</span></div>
                <div className="flex justify-between font-semibold border-t pt-1"><span>Total in stock</span><span>{fmtUSD(t.group + t.personal)}</span></div>
                <p className="text-[11px] text-muted-foreground">
                  {fmtUSD(t.group + t.personal)} of {s.party}'s {fmtUSD(base)} share of net before group stock is held as product instead of cash.
                  Group stock is funded equally by the partners ({equalPct(splits)}% each), whatever the profit split.
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* itemized stock expenditures with per-party contribution columns */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Stock expenditures — who contributed what</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Kits</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Value</TableHead>
                {splits.map(s => <TableHead key={s.party} className="text-right">{s.party}</TableHead>)}
                {hasOrphans && <TableHead className="text-right text-amber-300">Orphaned</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {stockRows.map(a => {
                const shares = rowShares(a);
                const kind = a.stock_plan_item_id != null ? 'stock plan' : a.stock ? 'group stock' : `personal: ${a.beneficiary}`;
                return (
                  <TableRow key={a.id}>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDate(a.created_at)}</TableCell>
                    <TableCell className="min-w-0 max-w-48 truncate" title={a.reason}>{a.sku_code}</TableCell>
                    <TableCell className="text-right">{fmtNum(a.qty)}</TableCell>
                    <TableCell>
                      <span className={`rounded text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap ${a.stock ? 'bg-emerald-400/10 text-emerald-300' : 'bg-indigo-400/10 text-indigo-300'}`}>
                        {kind}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium">{fmtUSD(rowValue(a))}</TableCell>
                    {splits.map(s => (
                      <TableCell key={s.party} className="text-right">{(shares[s.party] || 0) !== 0 ? fmtUSD(shares[s.party]) : '—'}</TableCell>
                    ))}
                    {hasOrphans && (
                      <TableCell className="text-right text-amber-300">{isOrphaned(a) ? fmtUSD(rowValue(a)) : '—'}</TableCell>
                    )}
                  </TableRow>
                );
              })}
              {stockRows.length > 0 && (
                <TableRow className="font-semibold border-t-2">
                  <TableCell colSpan={4}>Total</TableCell>
                  <TableCell className="text-right">{fmtUSD(stockRows.reduce((s, a) => s + rowValue(a), 0))}</TableCell>
                  {splits.map(s => (
                    <TableCell key={s.party} className="text-right">
                      {fmtUSD((contribTotals[s.party]?.group || 0) + (contribTotals[s.party]?.personal || 0))}
                    </TableCell>
                  ))}
                  {hasOrphans && <TableCell className="text-right text-amber-300">{fmtUSD(orphanedTotal)}</TableCell>}
                </TableRow>
              )}
              {stockRows.length === 0 && (
                <TableRow><TableCell colSpan={5 + splits.length + (hasOrphans ? 1 : 0)} className="text-center text-muted-foreground py-6">
                  {adjustmentsReady ? 'No stock expenditures yet.' : itemizedNote}
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
          {hasOrphans && (
            <div className="rounded border border-amber-400/40 bg-amber-400/5 p-2 text-xs text-amber-200 mt-2">
              <span className="font-semibold">{fmtUSD(orphanedTotal)} of personal stock is ORPHANED</span> — its beneficiary no longer
              matches a split party, so it is deducted from no one's payout and counts toward no one's contribution. Reassign it on the Products page.
            </div>
          )}
          <p className="text-[11px] text-muted-foreground mt-2">
            Group-stock rows (planner commits and direct group-stock adjustments) are funded EQUALLY by the current split parties ({splits.map(s => `${s.party} ${equalPct(splits)}%`).join(' / ')}), whatever the profit split — adding or removing a party re-derives these shares; this is a current-parties view, not a historical record. Personal rows belong entirely to their party. Values are the cost+freight snapshots taken when each row was created.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
