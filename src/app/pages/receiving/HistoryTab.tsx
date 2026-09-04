import React, { useState } from 'react';
import { fmtDateTime, fmtNum } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { productChipClass, boxConsumption } from './shared';
import type { RxAddress, Pkg, TransferRow } from './shared';

/**
 * The auditable receiving record (Ian 2026-08-31): EVERY received
 * package, forever — including boxes whose contents have since left
 * through part-outs and direct ships (those vanish from the Dashboard,
 * which shows only what's physically on hand). Original contents are
 * shown as received; the Status column says what has since happened.
 */
export function HistoryTab({ packages, transfers, addresses }: {
  packages: Pkg[]; transfers: TransferRow[]; addresses: RxAddress[];
}) {
  const [addrFilter, setAddrFilter] = useState('all');
  const [q, setQ] = useState('');

  const { remainingByPkg, consumedIds } = React.useMemo(
    () => boxConsumption(packages, transfers), [packages, transfers]);

  const received = packages
    .filter(p => p.received_at)
    .filter(p => addrFilter === 'all' || String(p.receive_address_id) === addrFilter)
    .filter(p => {
      const needle = q.trim().toLowerCase();
      if (!needle) return true;
      return String(p.tracking_number || '').toLowerCase().includes(needle)
        || (p.vendor_code || '').toLowerCase().includes(needle)
        || (p.items || []).some(i => i.sku_code.toLowerCase().includes(needle));
    })
    .sort((a, b) => String(b.received_at).localeCompare(String(a.received_at)));

  const statusOf = (p: Pkg) => {
    if (consumedIds.has(Number(p.id))) return { label: 'emptied', cls: 'bg-slate-400/10 text-slate-300', title: 'Everything in this box has left through finalized transfers (part-outs / direct ships)' };
    const rem = remainingByPkg.get(Number(p.id));
    const parted = (p.items || []).some(i =>
      (rem?.get(Number(i.product_id)) ?? Math.round(Number(i.qty) * 100)) < Math.round(Number(i.qty) * 100));
    if (parted) return { label: 'parted', cls: 'bg-violet-400/10 text-violet-300', title: 'Part of this box has left through finalized transfers — the rest is still on hand' };
    return { label: 'on hand', cls: 'bg-emerald-400/10 text-emerald-300', title: 'Nothing recorded as leaving this box' };
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Receiving history</CardTitle>
        <p className="text-xs text-muted-foreground">
          Every package ever received, as it arrived — the audit record. Boxes marked “emptied” no longer appear on the Dashboard.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Search tracking, vendor, SKU…" value={q} onChange={e => setQ(e.target.value)} className="h-8 w-64 text-sm" />
          <Select value={addrFilter} onValueChange={setAddrFilter}>
            <SelectTrigger className="h-8 w-44 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All addresses</SelectItem>
              {addresses.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground self-center">{received.length} package{received.length === 1 ? '' : 's'}</span>
        </div>
        <div className="border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>Address</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead>Carrier · tracking</TableHead>
                <TableHead>Contents as received</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {received.map(p => {
                const st = statusOf(p);
                return (
                  <TableRow key={p.id}>
                    <TableCell className="whitespace-nowrap text-xs">
                      {fmtDateTime(p.received_at)}
                      <span className="block text-[10px] text-muted-foreground">by {p.received_by}</span>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{p.address_label}</TableCell>
                    <TableCell className="text-xs">{p.vendor_code || '—'}</TableCell>
                    <TableCell className="text-xs font-mono break-all max-w-[220px]">
                      {p.carrier.toUpperCase()} · {p.tracking_mangled ? <span className="text-amber-300">(unreadable here)</span> : p.tracking_number}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex flex-wrap gap-1">
                        {(p.items || []).map(i => (
                          <span key={i.product_id} className={`rounded text-[10px] font-semibold px-1.5 py-0.5 whitespace-nowrap ${productChipClass(Number(i.product_id))}`}>
                            {i.sku_code} × {fmtNum(i.qty)}
                          </span>
                        ))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={`rounded text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap ${st.cls}`} title={st.title}>{st.label}</span>
                    </TableCell>
                  </TableRow>
                );
              })}
              {received.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6 text-sm">Nothing received{q || addrFilter !== 'all' ? ' matching the filters' : ' yet'}.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
