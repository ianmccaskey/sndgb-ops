import React from 'react';
import { Link } from 'react-router-dom';
import { useLoadAction } from '@uibakery/data';
import getDashboardStats from '@/actions/dashboard/getDashboardStats';
import getMoqProgress from '@/actions/dashboard/getMoqProgress';
import getDailyOrderSeries from '@/actions/dashboard/getDailyOrderSeries';
import listRailRecon from '@/actions/recon/listRailRecon';
import getPnl from '@/actions/financials/getPnl';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtNum } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle } from 'lucide-react';
import { Led } from '@/components/Led';
import {
  MomentumChart, ReconDonut, RailBars, PnlBlock, ProductBars,
  DailyPoint, RailRow, PnlData, ProductPerfRow,
} from '@/app/pages/DashboardCharts';

type Stats = {
  order_count: string; billed_usd: string; received_usd: string; due_usd: string; comp_usd: string; writeoff_usd: string;
  short_count: string; awaiting_count: string; over_count: string; held_count: string;
  owed_to_vendors_usd: string; overpaid_vendor_count: string; net_profit_usd: string;
  pending_crypto_count: string;
};

type MoqRow = {
  group_buy_product_id: number; sku_code: string; product_name: string; mass_label: string | null;
  vendor_code: string; target_moq: string; demand_qty: string; adjustment_qty: string;
  final_count: string; moq_met: boolean; gb_price_usd: string; vendor_order_value_usd: string;
};

function StatTile({ label, value, tone, sub }: { label: string; value: string; tone?: 'bad' | 'warn' | 'good'; sub?: string }) {
  const color = tone === 'bad' ? 'text-rose-400' : tone === 'warn' ? 'text-amber-300' : tone === 'good' ? 'text-emerald-300' : 'text-foreground';
  return (
    <div className="flex flex-col px-4 py-3 bg-background">
      <span className="text-xs text-muted-foreground truncate">{label}</span>
      <span className={`text-lg font-semibold font-mono mt-0.5 ${color}`}>{value}</span>
      {/* wraps instead of truncating: the full text was hover-only (title=),
          unreachable on touch, and 173px phone columns truncate every time */}
      {sub && <span className="text-[10px] leading-tight text-muted-foreground">{sub}</span>}
    </div>
  );
}

export function HomePage() {
  const { groupBuyId, groupBuy } = useApp();
  const enabled = groupBuyId != null;
  const [rawStats] = useLoadAction(getDashboardStats, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawMoq] = useLoadAction(getMoqProgress, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawDaily] = useLoadAction(getDailyOrderSeries, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawRails] = useLoadAction(listRailRecon, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawPnl] = useLoadAction(getPnl, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawProducts] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const s = firstRow<Stats>(rawStats);
  const moq = rows<MoqRow>(rawMoq);
  const daily = rows<DailyPoint>(rawDaily);
  const rails = rows<RailRow>(rawRails);
  const pnl = firstRow<PnlData>(rawPnl);
  const perfProducts = rows<ProductPerfRow>(rawProducts);

  const billed = parseFloat(s?.billed_usd || '0');
  const received = parseFloat(s?.received_usd || '0');
  // Collection health measures against DUE (billed minus comped items) —
  // gross billed stays displayed, but a fully-paid comped order is not a gap.
  const comp = parseFloat(s?.comp_usd || '0');
  const writeoff = parseFloat(s?.writeoff_usd || '0');
  const forgiven = comp + writeoff;
  const due = parseFloat(s?.due_usd || String(billed));
  const gap = due - received;
  const attention: { label: string; count: number; href: string }[] = [
    { label: 'orders short on payment', count: Number(s?.short_count || 0), href: '/recon' },
    { label: 'orders awaiting payment verification', count: Number(s?.awaiting_count || 0), href: '/recon' },
    { label: 'orders overpaid', count: Number(s?.over_count || 0), href: '/recon' },
    { label: 'pending crypto payments to verify', count: Number(s?.pending_crypto_count || 0), href: '/recon' },
    { label: 'orders on shipping hold', count: Number(s?.held_count || 0), href: '/fulfillment' },
    { label: 'vendors OVERPAID', count: Number(s?.overpaid_vendor_count || 0), href: '/vendors' },
  ].filter(a => a.count > 0);

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gradient w-fit">{groupBuy?.name || 'Dashboard'}</h1>
        <p className="text-sm text-muted-foreground mt-1">Campaign health at a glance</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-border/60 border border-border/60 rounded-lg overflow-hidden">
        <StatTile label="Orders" value={fmtNum(s?.order_count)} />
        <StatTile
          label={forgiven > 0 ? 'Due' : 'Billed'}
          value={fmtUSD(forgiven > 0 ? due : billed, { cents: false })}
          sub={forgiven > 0
            ? `${fmtUSD(billed, { cents: false })} billed${comp > 0 ? ` − ${fmtUSD(comp, { cents: false })} comped` : ''}${writeoff > 0 ? ` − ${fmtUSD(writeoff, { cents: false })} written off` : ''}`
            : undefined}
        />
        <StatTile label="Received (verified)" value={fmtUSD(s?.received_usd, { cents: false })} tone="good" />
        <StatTile label="Collection Gap" value={fmtUSD(gap, { cents: false })} tone={gap > 1 ? 'bad' : 'good'} />
        <StatTile label="Owed to Vendors" value={fmtUSD(s?.owed_to_vendors_usd, { cents: false })} tone="warn" />
        <StatTile label="Projected Net Profit" value={fmtUSD(s?.net_profit_usd, { cents: false })} tone="good" />
      </div>

      {attention.length > 0 && (
        <Card className="border-amber-400/40 bg-amber-400/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Led /><AlertTriangle className="w-4 h-4 text-amber-300" /> Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {attention.map(a => (
              <Link key={a.label} to={a.href} className="block text-sm text-amber-200 hover:underline">
                <span className="font-semibold">{a.count}</span> {a.label} →
              </Link>
            ))}
          </CardContent>
        </Card>
      )}

      <MomentumChart series={daily} endsOn={groupBuy?.ends_on || null} />

      <div className="grid gap-4 lg:grid-cols-2">
        {s && (
          <ReconDonut
            matched={Math.max(0, Number(s.order_count) - Number(s.short_count) - Number(s.awaiting_count) - Number(s.over_count))}
            short={Number(s.short_count)}
            over={Number(s.over_count)}
            awaiting={Number(s.awaiting_count)}
            billed={due}
            received={received}
          />
        )}
        <RailBars rails={rails} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {pnl && <PnlBlock pnl={pnl} />}
        <ProductBars products={perfProducts} />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">MOQ Progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {moq.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No products configured for this campaign yet — add them under Products.
            </p>
          )}
          {moq.map(m => {
            const demand = Number(m.demand_qty);
            const target = Number(m.target_moq);
            const pct = target > 0 ? Math.min(100, Math.round((demand / target) * 100)) : 0;
            return (
              <div key={m.group_buy_product_id}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="font-medium">
                    {m.sku_code}
                    <span className="text-muted-foreground font-normal"> · {m.vendor_code} · {fmtUSD(m.gb_price_usd)}</span>
                  </span>
                  <span className={m.moq_met ? 'text-emerald-300' : 'text-muted-foreground'}>
                    {fmtNum(demand)} / {fmtNum(target)}
                    {Number(m.adjustment_qty) !== 0 && (
                      <span className="text-muted-foreground"> (+{fmtNum(m.adjustment_qty)} admin → {fmtNum(m.final_count)})</span>
                    )}
                  </span>
                </div>
                <div className="h-2 mt-1 rounded bg-muted overflow-hidden">
                  <div
                    className={`h-full ${m.moq_met ? 'bg-emerald-400/100' : 'bg-cyan-400/100'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
