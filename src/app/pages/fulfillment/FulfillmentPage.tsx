import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listFulfillmentQueue from '@/actions/fulfillment/listFulfillmentQueue';
import saveShipment from '@/actions/fulfillment/saveShipment';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD } from '@/lib/fmt';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusPill } from '@/components/StatusPill';
import { Truck, PauseCircle } from 'lucide-react';

type QueueRow = {
  id: number; order_number: string; customer_name: string;
  address_line1: string | null; address_line2: string | null; city: string | null;
  state_code: string | null; postal_code: string | null;
  hold_shipping: boolean; customer_note: string | null; admin_note: string | null;
  recon_status: string | null; items_summary: string; item_count: string;
  shipment_id: number | null; shipment_status: string | null; carrier: string | null;
  tracking_number: string | null; label_cost_usd: string | null; box: string | null;
};

export function FulfillmentPage() {
  const { groupBuyId } = useApp();
  const [stage, setStage] = useState('ready');
  const enabled = groupBuyId != null;
  const [raw, , , reload] = useLoadAction(listFulfillmentQueue, [groupBuyId, stage], { group_buy_id: groupBuyId, stage }, { enabled });
  const queue = rows<QueueRow>(raw);
  const [doSave] = useMutateAction(saveShipment);

  const [editing, setEditing] = useState<QueueRow | null>(null);
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [labelCost, setLabelCost] = useState('');
  const [box, setBox] = useState('');
  const [status, setStatus] = useState('packed');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const openEdit = (r: QueueRow) => {
    setEditing(r);
    setCarrier(r.carrier || 'USPS');
    setTracking(r.tracking_number || '');
    setLabelCost(r.label_cost_usd || '');
    setBox(r.box || '');
    setStatus(r.shipment_status || 'packed');
    setNote('');
    setError('');
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true); setError('');
    try {
      await doSave({
        order_id: editing.id, carrier, tracking_number: tracking,
        label_cost_usd: Number(labelCost || 0), box, status, note,
      });
      setEditing(null);
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save shipment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Truck className="h-6 w-6 text-violet-600" /> Fulfillment
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          "Ready" = payment matched and not on hold. Held orders never appear in the pack queue.
        </p>
      </div>

      <Tabs value={stage} onValueChange={setStage}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="ready">Ready to pack</TabsTrigger>
          <TabsTrigger value="packed">Packed</TabsTrigger>
          <TabsTrigger value="shipped">Shipped</TabsTrigger>
          <TabsTrigger value="held">On hold</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order #</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Ship to</TableHead>
              <TableHead>Items</TableHead>
              <TableHead>Recon</TableHead>
              <TableHead>Shipment</TableHead>
              <TableHead>Tracking</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {queue.map(r => (
              <TableRow key={r.id}>
                <TableCell className="font-medium whitespace-nowrap">
                  {r.order_number}
                  {r.hold_shipping && <PauseCircle className="inline w-3.5 h-3.5 ml-1 text-amber-600" />}
                </TableCell>
                <TableCell>
                  {r.customer_name}
                  {r.customer_note && <div className="text-xs text-amber-700 max-w-[200px] truncate" title={r.customer_note}>“{r.customer_note}”</div>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                  {r.address_line1}{r.address_line2 ? `, ${r.address_line2}` : ''}<br />
                  {r.city}, {r.state_code} {r.postal_code}
                </TableCell>
                <TableCell className="text-xs max-w-[220px] truncate" title={r.items_summary}>{r.items_summary}</TableCell>
                <TableCell><StatusPill value={r.recon_status || 'awaiting'} /></TableCell>
                <TableCell><StatusPill value={r.shipment_status || 'pending'} /></TableCell>
                <TableCell className="text-xs font-mono">{r.tracking_number || '—'}</TableCell>
                <TableCell>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => openEdit(r)}>
                    {r.shipment_id ? 'Update' : 'Pack / ship'}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {queue.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">Nothing in this stage.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={editing != null} onOpenChange={v => { if (!v) setEditing(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Shipment — {editing?.order_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Input placeholder="Carrier" value={carrier} onChange={e => setCarrier(e.target.value)} className="h-9 w-28" />
              <Input placeholder="Tracking #" value={tracking} onChange={e => setTracking(e.target.value)} className="h-9 flex-1" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Input placeholder="Label cost $" value={labelCost} onChange={e => setLabelCost(e.target.value)} className="h-9 w-28" />
              <Input placeholder="Box (e.g. 6x4x4)" value={box} onChange={e => setBox(e.target.value)} className="h-9 w-32" />
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-9 flex-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['pending', 'packed', 'shipped', 'delivered', 'reshipped'].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Input placeholder="Note (e.g. reship reason)" value={note} onChange={e => setNote(e.target.value)} className="h-9" />
            {editing && Number(editing.label_cost_usd || 0) > 0 && (
              <p className="text-xs text-muted-foreground">Current label cost: {fmtUSD(editing.label_cost_usd)}</p>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            <Button size="sm" onClick={save} disabled={saving}>Save</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
