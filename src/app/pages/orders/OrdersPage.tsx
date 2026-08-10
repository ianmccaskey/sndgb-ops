import React, { useState } from 'react';
import { useLoadAction } from '@uibakery/data';
import listOrders from '@/actions/orders/listOrders';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusPill } from '@/components/StatusPill';
import { OrderDetailSheet } from './OrderDetailSheet';
import { ShoppingCart, PauseCircle } from 'lucide-react';

export type OrderListRow = {
  id: number; order_number: string; status: string; payment_rail: string | null;
  hold_shipping: boolean; contact_name: string | null; contact_email: string | null;
  discord_username: string | null; city: string | null; state_code: string | null;
  total_usd: string; placed_at: string | null; customer_name: string;
  recon_status: string | null; effective_received_usd: string | null; diff_usd: string | null;
  pending_payment_count: string | null; items_summary: string; item_count: string;
  shipment_status: string | null; tracking_number: string | null;
};

export function OrdersPage() {
  const { groupBuyId } = useApp();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [rail, setRail] = useState('all');
  const [recon, setRecon] = useState('all');
  const [openOrderId, setOpenOrderId] = useState<number | null>(null);

  const enabled = groupBuyId != null;
  const [raw, loading, , reload] = useLoadAction(
    listOrders,
    [groupBuyId, search, status, rail, recon],
    { group_buy_id: groupBuyId, search, status, rail, recon },
    { enabled },
  );
  const orders = rows<OrderListRow>(raw);

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="h-6 w-6 text-violet-600" /> Orders
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {orders.length} orders · imported from the ordering app, reconciled here
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input
            placeholder="Search order #, name, email, discord…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-9 w-full sm:w-64"
          />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="imported">imported</SelectItem>
              <SelectItem value="verified">verified</SelectItem>
              <SelectItem value="flagged">flagged</SelectItem>
              <SelectItem value="refunded">refunded</SelectItem>
              <SelectItem value="cancelled">cancelled</SelectItem>
            </SelectContent>
          </Select>
          <Select value={rail} onValueChange={setRail}>
            <SelectTrigger className="h-9 w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All rails</SelectItem>
              <SelectItem value="eth">eth</SelectItem>
              <SelectItem value="sol">sol</SelectItem>
              <SelectItem value="base">base</SelectItem>
              <SelectItem value="cash">cash</SelectItem>
            </SelectContent>
          </Select>
          <Select value={recon} onValueChange={setRecon}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All recon</SelectItem>
              <SelectItem value="matched">matched</SelectItem>
              <SelectItem value="short">short</SelectItem>
              <SelectItem value="over">over</SelectItem>
              <SelectItem value="awaiting">awaiting</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Phones: two-row entries with the essentials — no horizontal scrolling.
          Order # + total on the first row, customer + rail + recon on the second. */}
      <div className="md:hidden border rounded-lg divide-y">
        {loading && orders.length === 0 && (
          <p className="text-center text-muted-foreground py-8 text-sm">Loading…</p>
        )}
        {!loading && orders.length === 0 && (
          <p className="text-center text-muted-foreground py-8 text-sm">No orders yet — pull them on the Import page.</p>
        )}
        {orders.map(o => (
          <button
            key={o.id}
            type="button"
            onClick={() => setOpenOrderId(o.id)}
            className="w-full text-left px-3 py-2.5 active:bg-muted/60"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium whitespace-nowrap">
                {o.order_number}
                {o.hold_shipping && <PauseCircle className="inline w-3.5 h-3.5 ml-1 text-amber-600" />}
              </span>
              <span className="font-medium whitespace-nowrap">{fmtUSD(o.total_usd)}</span>
            </div>
            <div className="flex items-center justify-between gap-2 mt-1">
              <span className="text-sm text-muted-foreground truncate">{o.customer_name}</span>
              <span className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs uppercase text-muted-foreground">{o.payment_rail || '—'}</span>
                <StatusPill value={o.recon_status || 'awaiting'} />
              </span>
            </div>
          </button>
        ))}
      </div>

      {/* Tablets and up: the full table. */}
      <div className="hidden md:block border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order #</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Items</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Rail</TableHead>
              <TableHead>Recon</TableHead>
              <TableHead className="text-right">Diff</TableHead>
              <TableHead>Shipment</TableHead>
              <TableHead>Placed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && orders.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">Loading…</TableCell></TableRow>
            )}
            {!loading && orders.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No orders yet — paste an export on the Import page.</TableCell></TableRow>
            )}
            {orders.map(o => {
              const diff = parseFloat(o.diff_usd || '0');
              return (
                <TableRow key={o.id} className="cursor-pointer" onClick={() => setOpenOrderId(o.id)}>
                  <TableCell className="font-medium whitespace-nowrap">
                    {o.order_number}
                    {o.hold_shipping && <PauseCircle className="inline w-3.5 h-3.5 ml-1 text-amber-600" />}
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{o.customer_name}</div>
                    <div className="text-xs text-muted-foreground">{o.discord_username || o.contact_email || ''}</div>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate text-sm" title={o.items_summary}>{o.items_summary}</TableCell>
                  <TableCell className="text-right font-medium">{fmtUSD(o.total_usd)}</TableCell>
                  <TableCell>{o.payment_rail || '—'}</TableCell>
                  <TableCell><StatusPill value={o.recon_status || 'awaiting'} /></TableCell>
                  <TableCell className={`text-right ${Math.abs(diff) > 1 ? (diff > 0 ? 'text-red-600' : 'text-blue-600') : 'text-muted-foreground'}`}>
                    {Math.abs(diff) > 0.005 ? fmtUSD(diff) : '—'}
                  </TableCell>
                  <TableCell><StatusPill value={o.shipment_status} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(o.placed_at)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <OrderDetailSheet orderId={openOrderId} onClose={() => { setOpenOrderId(null); reload(); }} />
    </div>
  );
}
