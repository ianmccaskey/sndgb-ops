import React, { useMemo, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listFulfillmentQueue from '@/actions/fulfillment/listFulfillmentQueue';
import markOrderDirectFulfilled from '@/actions/fulfillment/markOrderDirectFulfilled';
import listReceiveAddresses from '@/actions/receiving/listReceiveAddresses';
import listProducts from '@/actions/products/listProducts';
import { useApp } from '@/app/AppContext';
import { useShippoHttp } from '@/lib/useShippoHttp';
import { isTestKey } from '@/lib/shippo';
import { B44_DEFAULT_APP_ID } from '@/lib/base44';
import { rows } from '@/lib/rows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { StatusPill } from '@/components/StatusPill';
import { productChipClass } from '@/app/pages/receiving/shared';
import type { RxAddress } from '@/app/pages/receiving/shared';
import { ShippingModal } from './ShippingModal';
import type { QueueOrder } from './ShippingModal';
import { Truck, PauseCircle } from 'lucide-react';

type QueueRow = QueueOrder & {
  hold_shipping: boolean; admin_note: string | null;
  recon_status: string | null;
  items_summary: string; item_count: string;
  remaining_summary: string; remaining_packable_qty: string; shipped_packable_qty: string;
  packable_json: { product_id: number; sku: string; remaining: number | string }[] | null;
  direct_items_summary: string; direct_outstanding_summary: string;
  direct_outstanding_ids: string; all_direct: boolean; direct_outstanding: boolean;
  shipment_state: string | null; shipment_count: string;
  has_draft: boolean; draft_needs_recovery: boolean; push_outstanding: boolean;
  tracking_numbers: string; label_cost_total: string;
};
type CatalogProduct = { id: number; sku_code: string; digital: boolean; active: boolean };

export function FulfillmentPage() {
  const { groupBuyId, userName, settings } = useApp();
  const shippoKey = settings.shippo_api_key || '';
  const testMode = shippoKey !== '' && isTestKey(shippoKey);
  const shippoHttp = useShippoHttp();
  const cfg = { appId: settings.base44_app_id || B44_DEFAULT_APP_ID, token: settings.base44_token || '' };
  const [stage, setStage] = useState('ready');
  // product filters: CONTAINS (order has remaining work on any selected
  // product) or ONLY (…and on nothing else). Both key on REMAINING work.
  const [filterIds, setFilterIds] = useState<Set<number>>(new Set());
  const [filterMode, setFilterMode] = useState<'contains' | 'only'>('contains');
  const productIdsCsv = Array.from(filterIds).sort((a, b) => a - b).join(',');
  const enabled = groupBuyId != null;
  const [raw, , , reload] = useLoadAction(listFulfillmentQueue,
    [groupBuyId, stage, productIdsCsv, filterMode],
    { group_buy_id: groupBuyId, stage, product_ids: productIdsCsv, filter_mode: filterMode },
    { enabled });
  const queue = rows<QueueRow>(raw);
  const [rawAddresses] = useLoadAction(listReceiveAddresses, [], {});
  const addresses = rows<RxAddress>(rawAddresses);
  const [rawProducts] = useLoadAction(listProducts, [], {});
  // digital products (COA certificates) are never packed — they don't
  // belong in the filter chips or the session pool
  const products = useMemo(() => rows<CatalogProduct>(rawProducts).filter(p => p.active && !p.digital), [rawProducts]);
  const [doMarkDirect] = useMutateAction(markOrderDirectFulfilled);

  const [shipping, setShipping] = useState<QueueRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // ---- shipment session: on-hand quantities typed by the operator; the
  // queue splits into fully / partially packable and the pool counts DOWN
  // as boxes ship (onShipped) ----
  const [sessionOpen, setSessionOpen] = useState(false);
  const [pool, setPool] = useState<Record<number, string>>({});
  const poolNum = (pid: number) => Number((pool[pid] ?? '').trim() || 0);
  const sessionActive = sessionOpen && Object.values(pool).some(v => Number(v) > 0);
  const packability = (r: QueueRow): 'full' | 'partial' | 'none' => {
    const lines = (r.packable_json || []).map(l => ({ pid: Number(l.product_id), remaining: Number(l.remaining) }));
    if (lines.length === 0) return 'none';
    const coverable = lines.filter(l => poolNum(l.pid) > 0);
    if (coverable.length === 0) return 'none';
    return lines.every(l => poolNum(l.pid) >= l.remaining) ? 'full' : 'partial';
  };
  const onShipped = (items: { product_id: number; qty: number }[]) => {
    setPool(p => {
      const n = { ...p };
      for (const i of items) {
        if (n[i.product_id] !== undefined && n[i.product_id] !== '') {
          n[i.product_id] = String(Math.max(0, Number(n[i.product_id]) - i.qty));
        }
      }
      return n;
    });
  };

  const displayQueue = useMemo(() => {
    if (!sessionActive || stage !== 'ready') return queue;
    const rank = { full: 0, partial: 1, none: 2 } as const;
    return [...queue].sort((a, b) => rank[packability(a)] - rank[packability(b)] || a.order_number.localeCompare(b.order_number));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, sessionActive, stage, JSON.stringify(pool)]);

  const toggleFilter = (pid: number) => {
    setFilterIds(s => { const n = new Set(s); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  };

  const markDirect = async (r: QueueRow, fulfilled: boolean) => {
    if (fulfilled && !window.confirm(`Mark the vendor-shipped items of ${r.order_number} as sent?\n\n${r.direct_outstanding_summary}`)) return;
    setSaving(true); setError('');
    try {
      // the confirmed ids travel with the call: the stamp is anchored to
      // exactly what the dialog listed, and refuses if lines changed since
      const res = await doMarkDirect({
        order_id: r.id, item_id: '',
        expected_ids: fulfilled ? r.direct_outstanding_ids : '',
        fulfilled, actor: userName,
      }) as unknown[] | null;
      if (fulfilled && !(Array.isArray(res) ? res.length > 0 : !!res)) {
        setError(`${r.order_number}'s direct lines changed since this list loaded — list refreshed, please check and try again.`);
      }
      reload();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to update direct-ship state');
    } finally {
      setSaving(false);
    }
  };

  const rowBadges = (r: QueueRow) => (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {r.shipment_state === 'partial' && <span className="rounded bg-blue-100 text-blue-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase">partial</span>}
      {r.has_draft && !r.draft_needs_recovery && <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title="An unfinished shipment draft exists — open Ship to continue or delete it">draft</span>}
      {r.draft_needs_recovery && <span className="rounded bg-red-100 text-red-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title="A draft's Shippo purchase was dispatched but never saved — it may hold a PAID label. Open Ship to recover.">needs recovery</span>}
      {r.push_outstanding && <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title="A shipped box has not been pushed to the ordering app — open Ship and use Push upstream">not pushed</span>}
      {sessionActive && stage === 'ready' && packability(r) === 'full' && <span className="rounded bg-green-100 text-green-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase">packable</span>}
      {sessionActive && stage === 'ready' && packability(r) === 'partial' && <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase">part-packable</span>}
    </span>
  );

  return (
    <div className="p-4 sm:p-6 space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Truck className="h-6 w-6 text-violet-600" /> Fulfillment
          {testMode && <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase">Shippo test mode</span>}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          "Ready" = payment matched, not held, and something REMAINS to pack — partially shipped orders stay here until their last box.
        </p>
      </div>

      <Tabs value={stage} onValueChange={setStage}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="ready">Ready to pack</TabsTrigger>
          <TabsTrigger value="direct">Direct ship</TabsTrigger>
          <TabsTrigger value="packed">Packed</TabsTrigger>
          <TabsTrigger value="shipped">Shipped</TabsTrigger>
          <TabsTrigger value="held">On hold</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {/* product filters — match REMAINING packable work */}
      <div className="flex flex-wrap items-center gap-1.5">
        {products.map(p => (
          <button key={p.id}
            className={`rounded text-[11px] font-semibold px-1.5 py-0.5 border ${filterIds.has(p.id) ? productChipClass(p.id) + ' border-transparent ring-2 ring-violet-400' : 'bg-muted text-muted-foreground border-transparent opacity-70'}`}
            onClick={() => toggleFilter(p.id)}>
            {p.sku_code}
          </button>
        ))}
        {filterIds.size > 0 && (
          <>
            <span className="inline-flex rounded border overflow-hidden text-[11px]">
              <button className={`px-2 py-0.5 ${filterMode === 'contains' ? 'bg-violet-600 text-white' : 'bg-background'}`}
                title="Orders with remaining work on ANY selected product (other items allowed)"
                onClick={() => setFilterMode('contains')}>contains</button>
              <button className={`px-2 py-0.5 ${filterMode === 'only' ? 'bg-violet-600 text-white' : 'bg-background'}`}
                title="Orders whose ENTIRE remaining work is within the selected products (vendor-direct lines ignored)"
                onClick={() => setFilterMode('only')}>only</button>
            </span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setFilterIds(new Set())}>clear</Button>
          </>
        )}
      </div>

      {/* shipment session */}
      <Card>
        <CardHeader className="pb-2 cursor-pointer" onClick={() => setSessionOpen(o => !o)}>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Shipment session {sessionActive && <span className="ml-1 text-xs font-normal text-muted-foreground">(active — pool counts down as you ship)</span>}</span>
            <span className="text-xs font-normal text-muted-foreground">{sessionOpen ? 'hide' : 'show'}</span>
          </CardTitle>
        </CardHeader>
        {sessionOpen && (
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Enter what you have on hand; orders in "Ready" sort and badge by what this pool can pack ("packable" = every remaining item covered; "part-packable" = a partial box is possible). Shipping a box deducts it live.
            </p>
            <div className="flex flex-wrap gap-2">
              {products.map(p => (
                <label key={p.id} className="flex items-center gap-1 text-xs">
                  <span className={`rounded px-1.5 py-0.5 font-semibold ${productChipClass(p.id)}`}>{p.sku_code}</span>
                  <Input value={pool[p.id] ?? ''} onChange={e => setPool(m => ({ ...m, [p.id]: e.target.value }))} className="h-7 w-16 text-xs" placeholder="0" />
                </label>
              ))}
            </div>
            {sessionActive && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPool({})}>Reset pool</Button>
            )}
          </CardContent>
        )}
      </Card>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* mobile: cards (same data, packing-first) */}
      <div className="md:hidden space-y-2">
        {displayQueue.map(r => (
          <div key={r.id} className="rounded-lg border p-3 space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{r.order_number} {r.hold_shipping && <PauseCircle className="inline w-3.5 h-3.5 text-amber-600" />}</p>
                <p className="text-sm truncate">{r.customer_name}</p>
              </div>
              <span className="flex gap-1 shrink-0">
                {stage === 'direct' ? (
                  <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => markDirect(r, true)}>Vendor shipped</Button>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShipping(r)}>Ship</Button>
                )}
                {stage !== 'direct' && r.direct_items_summary && !r.direct_outstanding && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={saving}
                    title="Put the vendor-shipped items back in the Direct ship tab"
                    onClick={() => markDirect(r, false)}>
                    Undo direct
                  </Button>
                )}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {r.address_line1}{r.address_line2 ? `, ${r.address_line2}` : ''} · {r.city}, {r.state_code} {r.postal_code}
            </p>
            <p className="text-xs">{stage === 'direct' ? r.direct_outstanding_summary : r.all_direct ? r.direct_items_summary : (stage === 'ready' ? (r.remaining_summary || r.items_summary) : r.items_summary)}</p>
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusPill value={r.recon_status || 'awaiting'} />
              <StatusPill value={r.shipment_state || 'pending'} />
              {rowBadges(r)}
            </div>
            {r.tracking_numbers && <p className="text-[11px] font-mono text-muted-foreground break-all">{r.tracking_numbers}</p>}
          </div>
        ))}
        {displayQueue.length === 0 && (
          <p className="text-center text-muted-foreground py-6 text-sm">Nothing in this stage{filterIds.size > 0 ? ' matching the product filter' : ''}.</p>
        )}
      </div>

      <div className="hidden md:block border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Order #</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Ship to</TableHead>
              <TableHead>{stage === 'ready' ? 'Remaining to pack' : 'Items'}</TableHead>
              <TableHead>Recon</TableHead>
              <TableHead>Shipment</TableHead>
              <TableHead>Tracking</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {displayQueue.map(r => (
              <TableRow key={r.id}>
                <TableCell className="font-medium whitespace-nowrap">
                  {r.order_number}
                  {r.hold_shipping && <PauseCircle className="inline w-3.5 h-3.5 ml-1 text-amber-600" />}
                  <div>{rowBadges(r)}</div>
                </TableCell>
                <TableCell>
                  {r.customer_name}
                  {r.customer_note && <div className="text-xs text-amber-700 max-w-[200px] truncate" title={r.customer_note}>“{r.customer_note}”</div>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                  {r.address_line1}{r.address_line2 ? `, ${r.address_line2}` : ''}<br />
                  {r.city}, {r.state_code} {r.postal_code}
                </TableCell>
                <TableCell className="text-xs max-w-[220px]">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span className="truncate" title={stage === 'direct' ? r.direct_outstanding_summary : r.all_direct ? r.direct_items_summary : (stage === 'ready' ? (r.remaining_summary || r.items_summary) : r.items_summary)}>
                      {stage === 'direct' ? r.direct_outstanding_summary : r.all_direct ? r.direct_items_summary : (stage === 'ready' ? (r.remaining_summary || r.items_summary) : r.items_summary)}
                    </span>
                    {stage !== 'direct' && !r.all_direct && r.direct_items_summary && (
                      <span
                        className={`rounded text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap ${r.direct_outstanding ? 'bg-violet-100 text-violet-900' : 'bg-green-100 text-green-900'}`}
                        title={`${r.direct_outstanding ? 'Vendor still owes' : 'Vendor shipped'}: ${r.direct_items_summary}`}
                      >
                        {r.direct_outstanding ? '+ direct' : 'direct ✓'}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell><StatusPill value={r.recon_status || 'awaiting'} /></TableCell>
                <TableCell>
                  <StatusPill value={r.shipment_state || 'pending'} />
                  {Number(r.shipment_count) > 1 && <span className="block text-[10px] text-muted-foreground">{r.shipment_count} boxes</span>}
                </TableCell>
                <TableCell className="text-xs font-mono max-w-[180px] truncate" title={r.tracking_numbers || undefined}>{r.tracking_numbers || '—'}</TableCell>
                <TableCell>
                  <span className="flex gap-1">
                    {stage === 'direct' ? (
                      <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => markDirect(r, true)}>
                        Vendor shipped
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShipping(r)}>
                        Ship
                      </Button>
                    )}
                    {stage !== 'direct' && r.direct_items_summary && !r.direct_outstanding && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" disabled={saving}
                        title="Put the vendor-shipped items back in the Direct ship tab"
                        onClick={() => markDirect(r, false)}>
                        Undo direct
                      </Button>
                    )}
                  </span>
                </TableCell>
              </TableRow>
            ))}
            {displayQueue.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">Nothing in this stage{filterIds.size > 0 ? ' matching the product filter (filters match REMAINING work to pack)' : ''}.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {shipping && (
        <ShippingModal
          order={shipping}
          addresses={addresses}
          shippoKey={shippoKey} shippoHttp={shippoHttp} testMode={testMode}
          settings={settings} cfg={cfg} userName={userName} groupBuyId={groupBuyId}
          onClose={() => { setShipping(null); reload(); }}
          onShipped={onShipped}
          reload={reload}
        />
      )}
    </div>
  );
}
