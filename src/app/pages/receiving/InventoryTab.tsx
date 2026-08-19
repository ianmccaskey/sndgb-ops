import React from 'react';
import { fmtNum } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { productChipClass } from './shared';
import type { RxAddress, InvRow } from './shared';

/**
 * Per-address inventory: received (delivered/marked packages' contents)
 * minus transferred out (finalized transfers). Negative on-hand renders
 * amber — it means an un-receive happened after a transfer, and hiding
 * it would hide a real discrepancy.
 */
export function InventoryTab({ inventory, addresses }: { inventory: InvRow[]; addresses: RxAddress[] }) {
  const byAddress = addresses
    .map(a => ({ address: a, rows: inventory.filter(r => r.receive_address_id === a.id) }))
    .filter(g => g.rows.length > 0);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {byAddress.map(({ address, rows: invRows }) => (
        <Card key={address.id}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">{address.label}{!address.active && <span className="ml-1 text-xs font-normal text-muted-foreground">(archived)</span>}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead className="text-right">Transferred</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invRows.map(r => {
                    const onHand = Number(r.on_hand_qty);
                    return (
                      <TableRow key={r.product_id}>
                        <TableCell>
                          <span className={`rounded text-[11px] font-semibold px-1.5 py-0.5 whitespace-nowrap ${productChipClass(r.product_id)}`}>{r.sku_code}</span>
                        </TableCell>
                        <TableCell className="text-right">{fmtNum(r.received_qty)}</TableCell>
                        <TableCell className="text-right">{fmtNum(r.transferred_qty)}</TableCell>
                        <TableCell className={`text-right font-semibold ${onHand < 0 ? 'text-amber-700' : ''}`}>
                          {fmtNum(r.on_hand_qty)}
                          {onHand < 0 && <span className="block text-[10px] font-normal">negative — a package was un-received after a transfer</span>}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}
      {byAddress.length === 0 && (
        <Card className="lg:col-span-2">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nothing received yet — inventory appears when a package is delivered (or marked received).
          </CardContent>
        </Card>
      )}
    </div>
  );
}
