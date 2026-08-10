import React, { useMemo } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  AreaChart, Area, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { fmtUSD, fmtNum } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/*
 * Dashboard analytics (dataviz-skill compliant):
 * - no dual axes — the momentum view is two stacked panels sharing the time axis
 * - fixed hue assignment: violet = billed/revenue, green = received/profit
 *   (color follows the entity across every chart, never its rank)
 * - status colors (matched/short/over/awaiting) reserved for the recon donut,
 *   always paired with a labeled legend — never color alone
 * - thin marks, rounded data ends, recessive grid, tooltips on all plots,
 *   values in text tokens (never series-colored text)
 */
const C_BILLED = 'var(--chart-3)';   // violet — billed / revenue
const C_RECEIVED = 'var(--chart-2)'; // green — received / profit
const STATUS_COLORS: Record<string, string> = {
  matched: 'rgb(22 163 74)',  // green-600
  short: 'rgb(220 38 38)',    // red-600
  over: 'rgb(37 99 235)',     // blue-600
  awaiting: 'rgb(217 119 6)', // amber-600
};

const GRID = 'rgb(9 9 11 / 0.06)';
const TICK = { fontSize: 11, fill: 'var(--muted-foreground)' } as const;

export type DailyPoint = { day: string; orders: string; billed_usd: string };

function fmtDayShort(d: string): string {
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
}

/** Buy momentum: orders/day bars + cumulative billed area, stacked panels. */
export function MomentumChart({ series, endsOn }: { series: DailyPoint[]; endsOn: string | null }) {
  const data = useMemo(() => {
    let cum = 0;
    return series.map(p => {
      cum += Number(p.billed_usd);
      return { day: fmtDayShort(p.day), orders: Number(p.orders), cumulative: +cum.toFixed(2) };
    });
  }, [series]);

  const daysLeft = useMemo(() => {
    if (!endsOn) return null;
    const ms = new Date(endsOn).getTime() - Date.now();
    return ms > 0 ? Math.ceil(ms / 86400000) : 0;
  }, [endsOn]);

  if (data.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          Buy momentum
          {daysLeft != null && (
            <span className="text-sm font-normal text-muted-foreground ml-2">
              {daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? '' : 's'} left` : 'buy ended'}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-xs text-muted-foreground">Orders per day</p>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" tick={TICK} tickLine={false} axisLine={false} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={30} allowDecimals={false} />
            <Tooltip formatter={(v: number) => [fmtNum(v), 'orders']} />
            <Bar dataKey="orders" fill={C_BILLED} radius={[4, 4, 0, 0]} maxBarSize={18} />
          </BarChart>
        </ResponsiveContainer>
        <p className="text-xs text-muted-foreground pt-1">Cumulative billed</p>
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" tick={TICK} tickLine={false} axisLine={false} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={54} tickFormatter={(v: number) => fmtUSD(v, { cents: false })} />
            <Tooltip formatter={(v: number) => [fmtUSD(v), 'billed to date']} />
            <Area dataKey="cumulative" stroke={C_BILLED} strokeWidth={2} fill={C_BILLED} fillOpacity={0.12} />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

/** Collection donut: recon status mix with % collected in the center. */
export function ReconDonut({ matched, short, over, awaiting, billed, received }: {
  matched: number; short: number; over: number; awaiting: number; billed: number; received: number;
}) {
  const data = [
    { name: 'matched', value: matched },
    { name: 'short', value: short },
    { name: 'over', value: over },
    { name: 'awaiting', value: awaiting },
  ].filter(d => d.value > 0);
  const pct = billed > 0 ? Math.round((received / billed) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Collection status</CardTitle></CardHeader>
      <CardContent>
        <div className="relative">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie data={data} dataKey="value" nameKey="name" innerRadius={58} outerRadius={82} paddingAngle={2} strokeWidth={0}>
                {data.map(d => <Cell key={d.name} fill={STATUS_COLORS[d.name]} />)}
              </Pie>
              <Tooltip formatter={(v: number, n: string) => [`${fmtNum(v)} orders`, n]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-2xl font-semibold">{pct}%</span>
            <span className="text-xs text-muted-foreground">collected</span>
          </div>
        </div>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-2 text-xs">
          {data.map(d => (
            <span key={d.name} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: STATUS_COLORS[d.name] }} />
              {d.name} <span className="text-muted-foreground">{fmtNum(d.value)}</span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export type RailRow = { payment_rail: string | null; order_count: string; billed_usd: string; received_usd: string };

/** Billed vs received per payment rail. */
export function RailBars({ rails }: { rails: RailRow[] }) {
  const data = rails
    .filter(r => Number(r.order_count) > 0)
    .map(r => ({
      rail: (r.payment_rail || '—').toUpperCase(),
      billed: Number(r.billed_usd),
      received: Number(r.received_usd),
    }));
  if (data.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Rails — billed vs received</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={230}>
          <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="rail" tick={TICK} tickLine={false} axisLine={false} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={54} tickFormatter={(v: number) => fmtUSD(v, { cents: false })} />
            <Tooltip formatter={(v: number, n: string) => [fmtUSD(v), n]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="billed" fill={C_BILLED} radius={[4, 4, 0, 0]} maxBarSize={26} />
            <Bar dataKey="received" fill={C_RECEIVED} radius={[4, 4, 0, 0]} maxBarSize={26} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

export type PnlData = {
  product_revenue_usd: string; admin_fee_revenue_usd: string; shipping_fee_revenue_usd: string;
  tip_revenue_usd: string; total_revenue_usd: string; expenses_usd: string; label_costs_usd: string;
  net_profit_usd: string; splits: { party: string; pct: string }[] | null;
};

/** Revenue composition + deductions + net + profit split. */
export function PnlBlock({ pnl }: { pnl: PnlData }) {
  const parts = [
    { name: 'Product', value: Number(pnl.product_revenue_usd), color: C_BILLED },
    { name: 'Admin fees', value: Number(pnl.admin_fee_revenue_usd), color: C_RECEIVED },
    { name: 'Shipping fees', value: Number(pnl.shipping_fee_revenue_usd), color: 'var(--chart-4)' },
    { name: 'Tips', value: Number(pnl.tip_revenue_usd), color: 'var(--chart-1)' },
  ].filter(p => p.value > 0);
  const total = Number(pnl.total_revenue_usd);
  const deductions = Number(pnl.expenses_usd) + Number(pnl.label_costs_usd);
  const net = Number(pnl.net_profit_usd);
  const splits = pnl.splits || [];

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">P&L composition</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {/* revenue composition: one horizontal stacked bar with 2px gaps */}
        <div>
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>Revenue</span><span className="font-medium text-foreground">{fmtUSD(total, { cents: false })}</span>
          </div>
          <div className="flex h-5 rounded overflow-hidden" style={{ gap: 2 }}>
            {parts.map(p => (
              <div
                key={p.name}
                title={`${p.name}: ${fmtUSD(p.value)}`}
                style={{ width: `${total > 0 ? (p.value / total) * 100 : 0}%`, background: p.color, minWidth: 3 }}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-xs">
            {parts.map(p => (
              <span key={p.name} className="inline-flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />
                {p.name} <span className="text-muted-foreground">{fmtUSD(p.value, { cents: false })}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="text-sm space-y-1 border-t pt-2">
          <div className="flex justify-between"><span className="text-muted-foreground">Expenses + labels</span><span className="text-red-600">−{fmtUSD(deductions, { cents: false })}</span></div>
          <div className="flex justify-between font-semibold"><span>Net profit</span><span className="text-green-700">{fmtUSD(net, { cents: false })}</span></div>
        </div>
        {splits.length > 0 && (
          <div className="text-sm space-y-1 border-t pt-2">
            {splits.map(s => (
              <div key={s.party} className="flex justify-between">
                <span className="text-muted-foreground">{s.party} ({Number(s.pct)}%)</span>
                <span>{fmtUSD(net * Number(s.pct) / 100, { cents: false })}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export type ProductPerfRow = {
  sku_code: string; expected_revenue_usd: string; total_product_profit_usd: string;
  moq_met: boolean; demand_qty: string; qty_cap: string | null; target_moq: string;
};

/** Top products by expected revenue, profit alongside; MOQ + cap summaries. */
export function ProductBars({ products }: { products: ProductPerfRow[] }) {
  const withMoq = products.filter(p => Number(p.target_moq) > 0);
  const moqMet = withMoq.filter(p => p.moq_met).length;
  const capped = products.filter(p => p.qty_cap != null);
  const soldOut = capped.filter(p => Number(p.demand_qty) >= Number(p.qty_cap));
  const top = [...products]
    .sort((a, b) => Number(b.expected_revenue_usd) - Number(a.expected_revenue_usd))
    .slice(0, 8)
    .map(p => ({
      sku: p.sku_code.length > 14 ? p.sku_code.slice(0, 13) + '…' : p.sku_code,
      revenue: Number(p.expected_revenue_usd),
      profit: Number(p.total_product_profit_usd),
    }));
  if (top.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">Top products</CardTitle></CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(160, top.length * 34)}>
          <BarChart data={top} layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={GRID} horizontal={false} />
            <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={(v: number) => fmtUSD(v, { cents: false })} />
            <YAxis type="category" dataKey="sku" tick={TICK} tickLine={false} axisLine={false} width={104} />
            <Tooltip formatter={(v: number, n: string) => [fmtUSD(v), n]} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="revenue" fill={C_BILLED} radius={[0, 4, 4, 0]} maxBarSize={12} />
            <Bar dataKey="profit" fill={C_RECEIVED} radius={[0, 4, 4, 0]} maxBarSize={12} />
          </BarChart>
        </ResponsiveContainer>
        <div className="text-xs text-muted-foreground mt-2 space-y-0.5">
          {withMoq.length > 0 && <p>{moqMet} of {withMoq.length} SKUs with a target have hit MOQ.</p>}
          {soldOut.length > 0 && (
            <p className="text-amber-700 font-medium">
              SOLD OUT (at cap): {soldOut.map(p => p.sku_code).join(', ')}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
