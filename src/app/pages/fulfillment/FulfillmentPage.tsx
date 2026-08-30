import React, { useMemo, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listFulfillmentQueue from '@/actions/fulfillment/listFulfillmentQueue';
import markOrderDirectFulfilled from '@/actions/fulfillment/markOrderDirectFulfilled';
import listReceiveAddresses from '@/actions/receiving/listReceiveAddresses';
import listProducts from '@/actions/products/listProducts';
import { useApp } from '@/app/AppContext';
import { useShippoHttp } from '@/lib/useShippoHttp';
import { isTestKey } from '@/lib/shippo';
import { B44_DEFAULT_APP_ID, listB44Orders } from '@/lib/base44';
import { rows } from '@/lib/rows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { fmtNum } from '@/lib/fmt';
import { StatusPill } from '@/components/StatusPill';
import { productChipClass } from '@/app/pages/receiving/shared';
import type { RxAddress } from '@/app/pages/receiving/shared';
import { ShippingModal } from './ShippingModal';
import type { QueueOrder } from './ShippingModal';
import { Truck, PauseCircle, Filter, Check, X } from 'lucide-react';

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
  const { groupBuyId, groupBuy, userName, settings } = useApp();
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

  const [filterOpen, setFilterOpen] = useState(false);

  // ---- shipment session: on-hand quantities typed by the operator; the
  // queue splits into fully / partially packable and the pool counts DOWN
  // as boxes ship (onShipped) ----
  const [sessionOpen, setSessionOpen] = useState(false);
  // default OFF (per Ian): an active session shows ONLY orders the pool
  // fully covers; partials appear only when toggled on
  const [showPartials, setShowPartials] = useState(false);
  const [pool, setPool] = useState<Record<number, string>>({});
  const [sAddProduct, setSAddProduct] = useState('');
  const [sAddQty, setSAddQty] = useState('');
  const poolEntries = Object.entries(pool);
  const poolUnitsLeft = poolEntries.reduce((s, [, v]) => s + Math.max(0, Number(v) || 0), 0);
  const addToPool = () => {
    if (!sAddProduct || !(Number(sAddQty) > 0)) return;
    // a NEW session (pool currently empty of stock) always starts
    // default-off for partials, even if a prior session toggled them on
    if (!Object.values(pool).some(v => Number(v) > 0)) setShowPartials(false);
    setPool(m => ({ ...m, [Number(sAddProduct)]: sAddQty.trim() }));
    setSAddProduct(''); setSAddQty('');
  };
  const poolNum = (pid: number) => Number((pool[pid] ?? '').trim() || 0);
  // active whenever the pool holds stock — hiding the card is a display
  // choice, not a session end (the toolbar button shows the loaded state;
  // Reset ends the session)
  const sessionActive = Object.values(pool).some(v => Number(v) > 0);
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

  // ---- upstream status check: pull every ordering-app order's status and
  // flag rows the ordering app marks shipped-like while no local shipment is
  // recorded (Paige marks shipped over there; this app is the record of
  // carrier + tracking). The snapshot stays bound to its full source
  // identity — campaign relink or settings edits make it inert, same
  // discipline as the Import pull. ----
  const [upstream, setUpstream] = useState<{
    forGroupBuyId: number; appId: string; gbExternalId: string; token: string;
    at: string; total: number; statusById: Record<string, string>;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const canCheck = !!cfg.token && !!groupBuy?.external_id;
  const checkUpstream = async () => {
    if (!canCheck || !groupBuy?.external_id || groupBuyId == null) return;
    const source = { forGroupBuyId: groupBuyId, appId: cfg.appId, gbExternalId: groupBuy.external_id, token: cfg.token };
    setChecking(true); setCheckError('');
    try {
      const orders = await listB44Orders(cfg, source.gbExternalId);
      const statusById: Record<string, string> = {};
      for (const o of orders) statusById[String(o.id)] = String(o.status ?? '');
      setUpstream({ ...source, at: new Date().toLocaleTimeString(), total: orders.length, statusById });
    } catch (e: unknown) {
      setCheckError(e instanceof Error ? e.message : 'Failed to check the ordering app');
    } finally {
      setChecking(false);
    }
  };
  const upstreamLive = upstream
    && upstream.forGroupBuyId === groupBuyId
    && upstream.gbExternalId === (groupBuy?.external_id || '')
    && upstream.appId === cfg.appId
    && upstream.token === cfg.token
    ? upstream : null;
  // upstream vocabulary is app-defined; anything mentioning ship/deliver
  // counts as "they consider it on its way". Local partial still flags —
  // upstream says done while boxes remain unrecorded here.
  const upstreamShippedLike = (s: string) => /ship|deliver/i.test(s);
  const LOCAL_SHIPPED = new Set(['shipped', 'delivered', 'reshipped']);
  const upstreamStatusOf = (r: QueueRow): string | undefined =>
    upstreamLive && r.external_id ? upstreamLive.statusById[String(r.external_id)] : undefined;
  const upstreamMismatch = (r: QueueRow): boolean => {
    const s = upstreamStatusOf(r);
    if (!s || !upstreamShippedLike(s)) return false;
    // vendor-direct completion is recorded WITHOUT a local shipment row —
    // an all-direct order whose vendor lines are marked sent is fully
    // accounted for here, never a mismatch
    if (r.all_direct && !r.direct_outstanding) return false;
    return !LOCAL_SHIPPED.has(r.shipment_state || '');
  };
  // the right recording flow differs: all-direct orders resolve via the
  // Direct ship tab's "Vendor shipped", everything else via Ship > manual
  const mismatchTitle = (r: QueueRow) => r.all_direct
    ? `The ordering app marks this order "${upstreamStatusOf(r)}" but its vendor-shipped items are not marked sent here — use "Vendor shipped" on the Direct ship tab`
    : `The ordering app marks this order "${upstreamStatusOf(r)}" but no shipment is fully recorded here — open Ship and record the carrier + tracking (manual entry)`;

  const displayQueue = useMemo(() => {
    if (!sessionActive || stage !== 'ready') return queue;
    const rank = { full: 0, partial: 1, none: 2 } as const;
    // the session FILTERS, not just sorts: only orders the pool fully
    // covers show by default; partials only when toggled, never 'none'
    return queue
      .filter(r => { const p = packability(r); return p === 'full' || (showPartials && p === 'partial'); })
      .sort((a, b) => rank[packability(a)] - rank[packability(b)] || a.order_number.localeCompare(b.order_number));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, sessionActive, stage, showPartials, JSON.stringify(pool)]);
  const sessionHiddenCount = sessionActive && stage === 'ready' ? queue.length - displayQueue.length : 0;
  // counted over the whole loaded stage, not the session-filtered view — a
  // session must not hide the existence of unrecorded-shipped orders
  const mismatchCount = upstreamLive ? queue.filter(upstreamMismatch).length : 0;

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
      {upstreamMismatch(r) && <span className="rounded bg-rose-100 text-rose-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title={mismatchTitle(r)}>shipped upstream</span>}
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

      {/* toolbar: product filter (searchable multi-select) + session toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={filterOpen} onOpenChange={setFilterOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-8">
              <Filter className="w-3.5 h-3.5 mr-1.5" />
              Filter products{filterIds.size > 0 ? ` (${filterIds.size})` : ''}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="p-0 w-72" align="start">
            <Command>
              <CommandInput placeholder="Search products…" />
              <CommandList>
                <CommandEmpty>No product matches.</CommandEmpty>
                {products.map(p => (
                  <CommandItem key={p.id} value={p.sku_code} onSelect={() => toggleFilter(p.id)}>
                    <Check className={`w-3.5 h-3.5 mr-2 ${filterIds.has(p.id) ? 'opacity-100' : 'opacity-0'}`} />
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${productChipClass(p.id)}`}>{p.sku_code}</span>
                  </CommandItem>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {filterIds.size > 0 && (
          <>
            <span className="inline-flex rounded-md border overflow-hidden text-xs h-8">
              <button className={`px-2.5 ${filterMode === 'contains' ? 'bg-violet-600 text-white' : 'bg-background text-muted-foreground'}`}
                title="Orders with remaining work on ANY selected product (other items allowed)"
                onClick={() => setFilterMode('contains')}>contains</button>
              <button className={`px-2.5 border-l ${filterMode === 'only' ? 'bg-violet-600 text-white' : 'bg-background text-muted-foreground'}`}
                title="Orders whose ENTIRE remaining work is within the selected products (vendor-direct lines ignored)"
                onClick={() => setFilterMode('only')}>only</button>
            </span>
            {products.filter(p => filterIds.has(p.id)).map(p => (
              <button key={p.id}
                className={`rounded text-[11px] font-semibold pl-1.5 pr-1 py-0.5 inline-flex items-center gap-1 ${productChipClass(p.id)}`}
                title="Remove from filter"
                onClick={() => toggleFilter(p.id)}>
                {p.sku_code}
                <X className="w-3 h-3 opacity-60" />
              </button>
            ))}
            <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setFilterIds(new Set())}>Clear</Button>
          </>
        )}
        <Button size="sm" variant="outline" className="h-8 ml-auto" disabled={!canCheck || checking}
          title={canCheck
            ? 'Pull every order\'s status from the ordering app and flag orders marked shipped there with no shipment recorded here'
            : 'Needs the ordering-app token in Settings and a campaign linked to the ordering app'}
          onClick={checkUpstream}>
          {checking ? 'Checking…' : 'Check ordering app'}
        </Button>
        <Button size="sm" variant={sessionActive ? 'default' : 'outline'} className="h-8" onClick={() => setSessionOpen(o => !o)}>
          Shipment session{poolEntries.length > 0 ? ` · ${poolEntries.length} product${poolEntries.length > 1 ? 's' : ''}` : ''}
        </Button>
      </div>

      {/* shipment session: only the products you SAY you have, as a tidy list */}
      {sessionOpen && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex flex-wrap items-center gap-2">
              <span>Shipment session</span>
              {sessionActive && (
                <span className="text-xs font-normal text-muted-foreground">
                  {poolEntries.length} product{poolEntries.length > 1 ? 's' : ''} · {fmtNum(poolUnitsLeft)} units left — counts down as you ship
                </span>
              )}
              <span className="ml-auto flex gap-1">
                {sessionActive && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setPool({}); setShowPartials(false); }}>Reset</Button>}
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSessionOpen(false)}>Hide</Button>
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={sAddProduct} onValueChange={setSAddProduct}>
                <SelectTrigger className="h-8 w-64"><SelectValue placeholder="Add a product you have on hand…" /></SelectTrigger>
                <SelectContent>
                  {products.filter(p => !(p.id in pool)).map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.sku_code}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input placeholder="Qty" value={sAddQty} onChange={e => setSAddQty(e.target.value)} className="h-8 w-20"
                onKeyDown={e => { if (e.key === 'Enter') addToPool(); }} />
              <Button size="sm" className="h-8" disabled={!sAddProduct || !(Number(sAddQty) > 0)} onClick={addToPool}>Add</Button>
            </div>
            {poolEntries.length > 0 && (
              <div className="border rounded-lg divide-y max-w-md">
                {poolEntries.map(([pid, qty]) => {
                  const p = products.find(x => x.id === Number(pid));
                  return (
                    <div key={pid} className="flex items-center gap-2 px-2 py-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${productChipClass(Number(pid))}`}>{p?.sku_code || pid}</span>
                      <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                        left:
                        <Input value={qty} onChange={e => setPool(m => ({ ...m, [Number(pid)]: e.target.value }))} className="h-7 w-20 text-xs text-right" />
                        <button className="p-0.5 opacity-60 hover:opacity-100" title="Remove from pool"
                          onClick={() => setPool(m => { const n = { ...m }; delete n[Number(pid)]; return n; })}>
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={showPartials} onChange={e => setShowPartials(e.target.checked)} />
                Show partially packable
              </label>
              {sessionHiddenCount > 0 && (
                <span className="text-xs text-muted-foreground">{sessionHiddenCount} order{sessionHiddenCount > 1 ? 's' : ''} hidden by the session</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              "Ready" shows only orders this pool fully covers — <span className="rounded bg-green-100 text-green-800 text-[10px] font-semibold px-1 py-0.5 uppercase">packable</span> = every remaining item covered{showPartials && <>; <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1 py-0.5 uppercase">part-packable</span> = a partial box is possible</>}.
            </p>
          </CardContent>
        </Card>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {checkError && <p className="text-sm text-red-600">{checkError}</p>}

      {/* upstream check result — persists until cleared or re-pulled so the
          rose "shipped upstream" badges have a visible legend */}
      {upstreamLive && (
        <div className={`rounded-lg border px-3 py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-1 ${mismatchCount > 0 ? 'border-rose-300 bg-rose-50' : 'border-green-300 bg-green-50'}`}>
          <span className={`font-medium ${mismatchCount > 0 ? 'text-rose-900' : 'text-green-900'}`}>
            Ordering app checked at {upstreamLive.at} ({fmtNum(upstreamLive.total)} orders) — {mismatchCount === 0
              ? `no order in this ${filterIds.size > 0 ? 'filtered view' : 'stage'} is marked shipped there without being recorded here.`
              : `${mismatchCount} order${mismatchCount > 1 ? 's' : ''} in this ${filterIds.size > 0 ? 'filtered view' : 'stage'} marked shipped there without being recorded here.`}
          </span>
          {mismatchCount > 0 && (
            <span className="text-rose-900">Look for the <span className="rounded bg-rose-100 text-rose-800 text-[10px] font-semibold px-1 py-0.5 uppercase">shipped upstream</span> badge — its tooltip names the recording flow (Ship, or Vendor shipped for direct orders).</span>
          )}
          {filterIds.size > 0 && (
            <span className="text-amber-800">The product filter is narrowing this check — orders outside it are not counted. <button className="underline" onClick={() => setFilterIds(new Set())}>Clear filter</button> for full-stage coverage.</span>
          )}
          <span className="text-muted-foreground">Switch to the All tab for coverage across every stage.</span>
          <span className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={checking} onClick={checkUpstream}>Refresh</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setUpstream(null)}>Clear</Button>
          </span>
        </div>
      )}

      {/* persistent whenever the session is filtering rows out — the
          collapsible card is not the only place this is visible, so a
          hidden card can never silently shrink the Ready queue */}
      {sessionActive && stage === 'ready' && sessionHiddenCount > 0 && (
        <div className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-medium text-violet-900">
            Shipment session is filtering "Ready" — {sessionHiddenCount} order{sessionHiddenCount > 1 ? 's' : ''} hidden.
          </span>
          <label className="flex items-center gap-1.5 cursor-pointer text-violet-900">
            <input type="checkbox" checked={showPartials} onChange={e => setShowPartials(e.target.checked)} />
            Show partially packable
          </label>
          {!sessionOpen && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setSessionOpen(true)}>Open session</Button>
          )}
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => { setPool({}); setShowPartials(false); }}>End session</Button>
        </div>
      )}

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
