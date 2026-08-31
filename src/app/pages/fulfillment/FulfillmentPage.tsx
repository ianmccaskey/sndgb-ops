import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listFulfillmentQueue from '@/actions/fulfillment/listFulfillmentQueue';
import markOrderDirectFulfilled from '@/actions/fulfillment/markOrderDirectFulfilled';
import getPackableItems from '@/actions/fulfillment/getPackableItems';
import adoptUpstreamShipment from '@/actions/fulfillment/adoptUpstreamShipment';
import listReceiveAddresses from '@/actions/receiving/listReceiveAddresses';
import listProducts from '@/actions/products/listProducts';
import { useApp } from '@/app/AppContext';
import { useShippoHttp } from '@/lib/useShippoHttp';
import { isTestKey } from '@/lib/shippo';
import { B44_DEFAULT_APP_ID, getB44Order, listB44Orders } from '@/lib/base44';
import { rows } from '@/lib/rows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
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
  upstream_check_json: { ext: string; effective: number | string; shipped: number | string }[] | null;
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
  // the mode is STICKY per device (localStorage): it resetting to
  // 'contains' on every load made phone and desktop silently disagree —
  // the same selection filtered "wrong" on mobile because the tiny
  // toggle had defaulted back
  const [filterMode, setFilterModeState] = useState<'contains' | 'only'>(() => {
    try { return localStorage.getItem('sndgb.fulfillFilterMode') === 'only' ? 'only' : 'contains'; } catch { return 'contains'; }
  });
  const setFilterMode = (m: 'contains' | 'only') => {
    setFilterModeState(m);
    try { localStorage.setItem('sndgb.fulfillFilterMode', m); } catch { /* per-device convenience only */ }
  };
  const productIdsCsv = Array.from(filterIds).sort((a, b) => a - b).join(',');
  const enabled = groupBuyId != null;
  const [raw, , , reload] = useLoadAction(listFulfillmentQueue,
    [groupBuyId, stage, productIdsCsv, filterMode],
    { group_buy_id: groupBuyId, stage, product_ids: productIdsCsv, filter_mode: filterMode },
    { enabled });
  const queue = rows<QueueRow>(raw);
  // BELT AND BRACES: filterMode sits in the load deps above, but the
  // platform runtime was observed (live, on mobile) NOT re-running the
  // load when only the mode string changed — the operator had to remove
  // and re-add a product chip to force a fetch. An explicit reload on
  // every mode change costs at most one duplicate idempotent read.
  const modeMounted = useRef(false);
  useEffect(() => {
    if (!modeMounted.current) { modeMounted.current = true; return; }
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterMode]);
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
  // free-text search over the loaded stage: order #, customer, tracking
  const [search, setSearch] = useState('');

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
    at: string; total: number;
    // per upstream order: status + which item product ids carry a
    // shipped_date there (the ordering app tracks shipment per ITEM);
    // qty preserved so adoption can clamp to what upstream actually shipped
    byId: Record<string, { status: string; shipped: { pid: string; date: string; qty: number }[] }>;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const canCheck = !!cfg.token && !!groupBuy?.external_id;
  // each check carries a request id; a completion older than the latest id
  // writes NOTHING — a check dispatched before a campaign/settings switch
  // can never repopulate results (or errors) after switching back
  const checkReq = useRef(0);
  const checkUpstream = async () => {
    if (!canCheck || !groupBuy?.external_id || groupBuyId == null) return;
    const source = { forGroupBuyId: groupBuyId, appId: cfg.appId, gbExternalId: groupBuy.external_id, token: cfg.token };
    const req = ++checkReq.current;
    setChecking(true); setCheckError('');
    try {
      // a stalled upstream must not wedge the button: the race loser is
      // simply dropped (nothing is attached to it), so a timeout leaves
      // the check retryable and a late resolution writes nothing
      const orders = await Promise.race([
        listB44Orders(cfg, source.gbExternalId),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Ordering app check timed out after 30 seconds — try again.')), 30000)),
      ]);
      if (req !== checkReq.current) return;
      const byId: Record<string, { status: string; shipped: { pid: string; date: string; qty: number }[] }> = {};
      for (const o of orders) {
        byId[String(o.id)] = {
          status: String(o.status ?? ''),
          shipped: (Array.isArray(o.items) ? o.items : [])
            .filter(it => it.shipped_date != null && String(it.shipped_date) !== '' && it.product_id != null)
            .map(it => ({ pid: String(it.product_id), date: String(it.shipped_date), qty: Number(it.quantity ?? 0) })),
        };
      }
      setUpstream({ ...source, at: new Date().toLocaleTimeString(), total: orders.length, byId });
    } catch (e: unknown) {
      if (req !== checkReq.current) return;
      setCheckError(e instanceof Error ? e.message : 'Failed to check the ordering app');
    } finally {
      if (req === checkReq.current) setChecking(false);
    }
  };
  // hard-DROP the snapshot on any source-identity change (not just hide
  // it): switching campaigns or editing settings and switching back must
  // never resurrect an old check as if it were current
  // show only the rows the check flagged (badge rows) — banner-toggled
  const [showFlaggedOnly, setShowFlaggedOnly] = useState(false);
  useEffect(() => {
    checkReq.current++;
    setUpstream(null); setCheckError(''); setChecking(false); setShowFlaggedOnly(false);
  }, [groupBuyId, groupBuy?.external_id, cfg.appId, cfg.token]);
  const upstreamLive = upstream
    && upstream.forGroupBuyId === groupBuyId
    && upstream.gbExternalId === (groupBuy?.external_id || '')
    && upstream.appId === cfg.appId
    && upstream.token === cfg.token
    ? upstream : null;
  // upstream vocabulary is app-defined, so shipped-like is an EXACT
  // allowlist of the statuses Paige actually sets — a loose substring
  // match would badge exception states ("delivery exception",
  // "undeliverable return") and drive bogus manual records. Statuses that
  // merely LOOK shipping-related surface informationally, never as badges.
  const upstreamShippedLike = (s: string) => ['shipped', 'delivered'].includes(s.trim().toLowerCase());
  // discovered live 2026-08-30: the ordering app's partial vocabulary is
  // 'partially_shipped' — recognized as its own class, never as fully shipped
  const upstreamPartial = (s: string) => s.trim().toLowerCase() === 'partially_shipped';
  const upstreamShipAdjacent = (s: string) => !upstreamShippedLike(s) && !upstreamPartial(s) && /ship|deliver/i.test(s);
  const LOCAL_SHIPPED = new Set(['shipped', 'delivered', 'reshipped']);
  const upstreamInfoOf = (r: QueueRow) =>
    upstreamLive && r.external_id ? upstreamLive.byId[String(r.external_id)] : undefined;
  const upstreamStatusOf = (r: QueueRow): string | undefined => upstreamInfoOf(r)?.status;
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
  // partially_shipped upstream, checked PER ITEM against finalized local
  // evidence: an upstream-shipped item whose local line has no finalized
  // shipped quantity is an unrecorded box — an unrelated older local box
  // (or a mere draft) on some OTHER line must not suppress the warning.
  // Items that don't map to a local line fall back to the order-level
  // finalized check.
  const partialMismatch = (r: QueueRow): boolean => {
    const info = upstreamInfoOf(r);
    if (!info || !upstreamPartial(info.status)) return false;
    if (r.all_direct && !r.direct_outstanding) return false;
    const locals = r.upstream_check_json || [];
    const mapped = info.shipped.filter(u => locals.some(l => String(l.ext) === u.pid));
    if (mapped.length > 0) {
      // quantity-deficit aware: local finalized shipped must cover the
      // upstream-shipped quantity (capped at local effective); unusable
      // upstream quantities fall back to the any-coverage check
      return mapped.some(u => {
        const l = locals.find(x => String(x.ext) === u.pid)!;
        const eff = Number(l.effective);
        if (!(eff > 0)) return false;
        const shipped = Number(l.shipped);
        const target = Number.isFinite(u.qty) && u.qty > 0 ? Math.min(u.qty, eff) : null;
        return target != null ? shipped < target : !(shipped > 0);
      });
    }
    return !(Number(r.shipped_packable_qty) > 0);
  };
  const partialTitle = (r: QueueRow) => r.all_direct
    ? 'The ordering app marks this order "partially_shipped" but nothing is recorded here — mark the sent vendor items via "Vendor shipped" on the Direct ship tab'
    : 'The ordering app marks this order "partially_shipped" but nothing is recorded here — open Ship and record the already-shipped box (manual entry, with its quantities)';

  // ---- adopt an upstream shipment: turn the ordering app's per-item
  // shipped facts into a local finalized shipment record (no tracking,
  // carrier 'upstream') so those quantities leave "remaining to pack"
  // and cannot be shipped again ----
  const [adopting, setAdopting] = useState<QueueRow | null>(null);
  const [rawAdoptLines, adoptLinesLoading] = useLoadAction(getPackableItems,
    [adopting?.id ?? 0], { order_id: adopting?.id ?? 0 }, { enabled: !!adopting });
  const [doAdopt] = useMutateAction(adoptUpstreamShipment);
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptMsg, setAdoptMsg] = useState('');
  type AdoptLine = {
    order_item_id: number; sku_code: string; product_external_id: string | null;
    digital: boolean; direct_ship: boolean; remaining_qty: string;
  };
  const adoptInfo = adopting ? upstreamInfoOf(adopting) : undefined;
  const adoptFull = !!adoptInfo && upstreamShippedLike(adoptInfo.status);
  // upstream facts keep their qty/date cardinality: same-pid entries on
  // ONE date sum their quantities and the adopted qty is clamped to what
  // upstream actually shipped; same-pid entries across DIFFERENT dates
  // (or unusable upstream quantities) are AMBIGUOUS and fail closed —
  // listed, excluded, and pointed at Ship > manual entry instead.
  const adoptComputed = useMemo(() => {
    const empty = { lines: [] as (AdoptLine & { date: string | null; adopt_qty: string; clamped: boolean })[], ambiguous: [] as string[] };
    if (!adopting || !adoptInfo) return empty;
    const out = { lines: [...empty.lines], ambiguous: [...empty.ambiguous] };
    for (const l of rows<AdoptLine>(rawAdoptLines)) {
      if (l.direct_ship || l.digital || !(Number(l.remaining_qty) > 0)) continue;
      const entries = adoptInfo.shipped.filter(x => x.pid === String(l.product_external_id));
      const dates = Array.from(new Set(entries.map(e => e.date)));
      if (dates.length > 1) { out.ambiguous.push(l.sku_code); continue; }
      if (entries.length === 0) {
        // no per-item fact: only order-level shipped/delivered covers it
        if (adoptFull) out.lines.push({ ...l, date: null, adopt_qty: String(l.remaining_qty), clamped: false });
        continue;
      }
      const upQty = entries.reduce((s, e) => s + (Number.isFinite(e.qty) && e.qty > 0 ? e.qty : 0), 0);
      if (!(upQty > 0)) { out.ambiguous.push(l.sku_code); continue; }
      const m = Math.min(Number(l.remaining_qty), upQty);
      if (!(m > 0)) continue;
      out.lines.push({ ...l, date: dates[0], adopt_qty: m.toFixed(2), clamped: m < Number(l.remaining_qty) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adopting, rawAdoptLines, adoptFull, JSON.stringify(adoptInfo?.shipped)]);
  const adoptLines = adoptComputed.lines;
  // undated lines only exist on order-level shipped/delivered adoption;
  // they need an explicit operator confirmation (the order status alone
  // is weaker evidence than a per-item date)
  const undatedCount = adoptLines.filter(l => l.date == null).length;
  const [adoptConfirmed, setAdoptConfirmed] = useState(false);
  useEffect(() => { setAdoptConfirmed(false); }, [adopting?.id]);
  const runAdopt = async () => {
    if (!adopting || groupBuyId == null || adoptLines.length === 0) return;
    if (undatedCount > 0 && !adoptConfirmed) return;
    setAdoptBusy(true); setAdoptMsg('');
    try {
      // confirm-time freshness: re-read THIS upstream order and require
      // the facts the adoption set was built from to still hold — the
      // other admin may have corrected the ordering app since the check
      const fresh = await getB44Order(cfg, String(adopting.external_id || ''));
      const freshStatus = String(fresh.status ?? '');
      const freshShipped = (Array.isArray(fresh.items) ? fresh.items : [])
        .filter(it => it.shipped_date != null && String(it.shipped_date) !== '' && it.product_id != null)
        .map(it => ({ pid: String(it.product_id), date: String(it.shipped_date), qty: Number(it.quantity ?? 0) }));
      const stale = adoptLines.some(l => {
        if (l.date == null) return !upstreamShippedLike(freshStatus);
        const entries = freshShipped.filter(x => x.pid === String(l.product_external_id));
        const dates = Array.from(new Set(entries.map(e => e.date)));
        if (dates.length !== 1 || dates[0] !== l.date) return true;
        const upQty = entries.reduce((s, e) => s + (Number.isFinite(e.qty) && e.qty > 0 ? e.qty : 0), 0);
        return upQty + 1e-9 < Number(l.adopt_qty);
      });
      if (stale) {
        setAdoptMsg('The ordering app changed since the check ran — nothing was recorded. Close, run "Check ordering app" again, and re-open.');
        return;
      }
      // one shipment row PER upstream ship date, each carrying its true
      // shipped_at; undated lines (order-level evidence) become their own
      // row stamped now() with the note saying the date is unknown
      const groups = new Map<string, typeof adoptLines>();
      for (const l of adoptLines) {
        const k = l.date ?? '';
        groups.set(k, [...(groups.get(k) ?? []), l]);
      }
      // the ordering app stores shipped_date as display text ("Aug 28,
      // 2026") — the fn wants YYYY-MM-DD, so normalize here; an
      // unparseable date falls back to '' (recorded now() + "date
      // unknown" note) rather than refusing the whole record
      const isoDate = (s: string): string => {
        const t = Date.parse(s);
        return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-CA') : '';
      };
      let recorded = 0;
      for (const [date, lines] of groups) {
        const note = `Recorded from ordering app (status "${adoptInfo?.status ?? ''}"; ${date
          ? `item shipped date ${date}`
          : 'no per-item ship date — adopted on the order-level status, date unknown'}) — no tracking; adopted via the upstream check.`;
        const res = await doAdopt({
          order_id: adopting.id, group_buy_id: groupBuyId,
          items: JSON.stringify(lines.map(l => ({ order_item_id: l.order_item_id, qty: l.adopt_qty }))),
          shipped_date: date ? isoDate(date) : '', note, actor: userName,
        }) as unknown[] | null;
        if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
          setAdoptMsg(recorded > 0
            ? `${recorded} box${recorded > 1 ? 'es' : ''} recorded, then one refused — the order changed underneath (a draft or box may now cover the rest). Close and re-check.`
            : 'Not recorded — the order changed since this list loaded (a draft or box may now cover these items, or the order was cancelled). Close and re-check.');
          reload();
          return;
        }
        recorded += 1;
      }
      setAdopting(null);
      reload();
    } catch (e: unknown) {
      setAdoptMsg(e instanceof Error ? e.message : 'Failed to record the upstream shipment');
      reload();
    } finally {
      setAdoptBusy(false);
    }
  };

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
  // flagged-only narrows AFTER the session filter; inert without a live
  // snapshot (the toggle resets when the snapshot drops). The text
  // search narrows last: order #, customer, contact, or tracking.
  const searchQ = search.trim().toLowerCase();
  const visibleQueue = (upstreamLive && showFlaggedOnly
    ? displayQueue.filter(r => upstreamMismatch(r) || partialMismatch(r))
    : displayQueue
  ).filter(r => !searchQ || [r.order_number, r.customer_name, r.contact_name, r.tracking_numbers]
    .some(v => String(v || '').toLowerCase().includes(searchQ)));
  // counted over the whole loaded stage, not the session-filtered view — a
  // session must not hide the existence of unrecorded-shipped orders.
  // listFulfillmentQueue caps at 1000 rows; at the cap the stage may be
  // truncated, so the banner must not claim clean stage-wide coverage
  const mismatchCount = upstreamLive ? queue.filter(upstreamMismatch).length : 0;
  const partialMismatchCount = upstreamLive ? queue.filter(partialMismatch).length : 0;
  const queueTruncated = queue.length >= 1000;
  // ship-adjacent-but-unrecognized statuses get named in the banner so a
  // vocabulary change upstream degrades visibly, never silently
  const shipAdjacentStatuses = upstreamLive
    ? Array.from(new Set(queue.map(upstreamStatusOf).filter((s): s is string => !!s && upstreamShipAdjacent(s))))
    : [];

  const toggleFilter = (pid: number) => {
    setFilterIds(s => { const n = new Set(s); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  };

  // ---- vendor-shipped dialog: pick WHICH direct lines the vendor's box
  // covered (subset allowed) and optionally record the vendor's carrier +
  // tracking on them; the stamp is anchored all-or-nothing to the chosen
  // ids so one shared tracking never lands on half its lines ----
  const [directing, setDirecting] = useState<QueueRow | null>(null);
  const [rawDirectLines, directLinesLoading] = useLoadAction(getPackableItems,
    ['direct', directing?.id ?? 0], { order_id: directing?.id ?? 0 }, { enabled: !!directing });
  type DirectLine = { order_item_id: number; sku_code: string; effective_qty: string; direct_ship: boolean; direct_fulfilled_at: string | null; digital: boolean };
  // NOT digital mirrors the queue's direct-side projection — a misflagged
  // digital+direct line is not vendor shipping work and must never be
  // stamped (the action refuses digital lines server-side too)
  const directLines = useMemo(() =>
    rows<DirectLine>(rawDirectLines).filter(l => l.direct_ship && !l.direct_fulfilled_at && !l.digital),
    [rawDirectLines]);
  const [directChecked, setDirectChecked] = useState<Set<number>>(new Set());
  // PER-LINE vendor label (Ian: each selected direct package gets its own
  // carrier + tracking)
  const [dvByLine, setDvByLine] = useState<Record<number, { carrier: string; tracking: string }>>({});
  const [directBusy, setDirectBusy] = useState(false);
  const [directMsg, setDirectMsg] = useState('');
  useEffect(() => {
    // fresh dialog: everything checked, fields cleared
    setDirectChecked(new Set(directLines.map(l => Number(l.order_item_id))));
    setDvByLine({}); setDirectMsg('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [directing?.id, JSON.stringify(directLines.map(l => l.order_item_id))]);
  const runVendorShipped = async () => {
    if (!directing || directChecked.size === 0) return;
    const chosen = directLines.filter(l => directChecked.has(Number(l.order_item_id)));
    // validate every chosen line BEFORE stamping anything
    for (const l of chosen) {
      const dv = dvByLine[Number(l.order_item_id)] || { carrier: '', tracking: '' };
      if (dv.tracking.trim() && !dv.carrier.trim()) {
        setDirectMsg(`${l.sku_code}: enter the carrier for its tracking number (or clear the tracking).`);
        return;
      }
    }
    setDirectBusy(true); setDirectMsg('');
    // one audited stamp PER line (item_id mode), each carrying its own
    // vendor label; a mid-sequence refusal reports exactly which line and
    // how many landed — earlier stamps are correct and stay
    let stamped = 0;
    try {
      for (const l of chosen) {
        const dv = dvByLine[Number(l.order_item_id)] || { carrier: '', tracking: '' };
        const res = await doMarkDirect({
          order_id: directing.id, item_id: String(l.order_item_id), expected_ids: '',
          fulfilled: true, vendor_carrier: dv.carrier, vendor_tracking: dv.tracking, actor: userName,
        }) as unknown[] | null;
        if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
          setDirectMsg(`${l.sku_code} refused — it changed since this list loaded (reset, removed, or stamped in another session). ${stamped > 0 ? `${stamped} earlier line${stamped > 1 ? 's were' : ' was'} marked with their tracking.` : 'Nothing was marked.'} Close and re-open.`);
          reload();
          return;
        }
        stamped += 1;
      }
      setDirecting(null);
      reload();
    } catch (e: unknown) {
      setDirectMsg((e instanceof Error ? e.message : 'Failed to mark vendor shipped')
        + (stamped > 0 ? ` — ${stamped} line${stamped > 1 ? 's were' : ' was'} already marked.` : ''));
      reload();
    } finally {
      setDirectBusy(false);
    }
  };

  const markDirect = async (r: QueueRow, fulfilled: boolean) => {
    if (fulfilled) { setDirecting(r); return; }
    setSaving(true); setError('');
    try {
      const res = await doMarkDirect({
        order_id: r.id, item_id: '', expected_ids: '',
        fulfilled, vendor_carrier: '', vendor_tracking: '', actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
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
      {partialMismatch(r) && <span className="rounded bg-orange-100 text-orange-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title={partialTitle(r)}>partial upstream</span>}
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

      {/* toolbar: search + product filter (searchable multi-select) + session toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative">
          <Input placeholder="Search order #, customer, tracking…" value={search}
            onChange={e => setSearch(e.target.value)} className="h-8 w-64 pr-7 text-sm" />
          {search && (
            <button className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100"
              title="Clear search" onClick={() => setSearch('')}>
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </span>
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
        <div className={`rounded-lg border px-3 py-1.5 text-xs flex flex-wrap items-center gap-x-3 gap-y-1 ${mismatchCount > 0 ? 'border-rose-300 bg-rose-50' : (partialMismatchCount > 0 || queueTruncated) ? 'border-amber-300 bg-amber-50' : 'border-green-300 bg-green-50'}`}>
          <span className={`font-medium ${mismatchCount > 0 ? 'text-rose-900' : (partialMismatchCount > 0 || queueTruncated) ? 'text-amber-900' : 'text-green-900'}`}>
            Ordering app checked at {upstreamLive.at} ({fmtNum(upstreamLive.total)} orders) — {mismatchCount === 0
              ? `no order in this ${filterIds.size > 0 ? 'filtered view' : 'stage'} is marked shipped there without being recorded here.`
              : `${mismatchCount} order${mismatchCount > 1 ? 's' : ''} in this ${filterIds.size > 0 ? 'filtered view' : 'stage'} marked shipped there without being recorded here.`}
          </span>
          {partialMismatchCount > 0 && (
            <span className="text-orange-800">{partialMismatchCount} order{partialMismatchCount > 1 ? 's' : ''} partially shipped there with nothing recorded here — see the <span className="rounded bg-orange-100 text-orange-800 text-[10px] font-semibold px-1 py-0.5 uppercase">partial upstream</span> badge.</span>
          )}
          {queueTruncated && (
            <span className="text-amber-800">Only the first 1000 loaded orders were checked — this stage may hold more; narrow by stage or product filter to cover the rest.</span>
          )}
          {shipAdjacentStatuses.length > 0 && (
            <span className="text-amber-800">Unrecognized shipping-related upstream status{shipAdjacentStatuses.length > 1 ? 'es' : ''} not flagged: {shipAdjacentStatuses.map(s => `"${s}"`).join(', ')} — only "shipped"/"delivered" are recognized; review these by eye.</span>
          )}
          {mismatchCount > 0 && (
            <span className="text-rose-900">Look for the <span className="rounded bg-rose-100 text-rose-800 text-[10px] font-semibold px-1 py-0.5 uppercase">shipped upstream</span> badge — its tooltip names the recording flow (Ship, or Vendor shipped for direct orders).</span>
          )}
          {filterIds.size > 0 && (
            <span className="text-amber-800">The product filter is narrowing this check — orders outside it are not counted. <button className="underline" onClick={() => setFilterIds(new Set())}>Clear filter</button> for full-stage coverage.</span>
          )}
          <span className="text-muted-foreground">Switch to the All tab for coverage across every stage.</span>
          <span className="ml-auto flex gap-1">
            {(mismatchCount > 0 || partialMismatchCount > 0) && (
              <Button size="sm" variant={showFlaggedOnly ? 'default' : 'outline'} className="h-6 px-2 text-xs"
                onClick={() => setShowFlaggedOnly(v => !v)}>
                {showFlaggedOnly ? 'Show all orders' : 'Show flagged only'}
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" disabled={checking} onClick={checkUpstream}>Refresh</Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => { setUpstream(null); setShowFlaggedOnly(false); }}>Clear</Button>
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
        {visibleQueue.map(r => (
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
                {(upstreamMismatch(r) || partialMismatch(r)) && !r.all_direct && (
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-700" title="Record the ordering app's shipped items as a local shipment"
                    onClick={() => { setAdoptMsg(''); setAdopting(r); }}>Record here</Button>
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
        {visibleQueue.length === 0 && (
          <p className="text-center text-muted-foreground py-6 text-sm">{searchQ ? `No order in this stage matches “${search.trim()}” — try the All tab, or clear the search.` : showFlaggedOnly && upstreamLive ? 'No flagged orders in this stage — "Show all orders" in the banner restores the full list.' : `Nothing in this stage${filterIds.size > 0 ? ' matching the product filter' : ''}.`}</p>
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
            {visibleQueue.map(r => (
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
                    {(upstreamMismatch(r) || partialMismatch(r)) && !r.all_direct && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-700" title="Record the ordering app's shipped items as a local shipment"
                        onClick={() => { setAdoptMsg(''); setAdopting(r); }}>Record here</Button>
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
            {visibleQueue.length === 0 && (
              <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">{searchQ ? `No order in this stage matches “${search.trim()}” — try the All tab, or clear the search.` : showFlaggedOnly && upstreamLive ? 'No flagged orders in this stage — "Show all orders" in the banner restores the full list.' : `Nothing in this stage${filterIds.size > 0 ? ' matching the product filter (filters match REMAINING work to pack)' : ''}.`}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* vendor-shipped dialog: choose which direct lines the vendor's
          box covered + optionally record the vendor's tracking on them */}
      <Dialog open={!!directing} onOpenChange={o => { if (!o) setDirecting(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Vendor shipped — {directing?.order_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Tick the lines the vendor shipped — unticked lines stay in the Direct ship tab. Each ticked line takes its OWN carrier +
              tracking (optional), recorded on that line.
            </p>
            {directLinesLoading && <p className="text-xs text-muted-foreground">Loading lines…</p>}
            {!directLinesLoading && directLines.length === 0 && (
              <p className="text-xs text-amber-700">No outstanding direct lines — they may have been marked in another session.</p>
            )}
            {directLines.length > 0 && (
              <div className="border rounded-lg divide-y">
                {directLines.map(l => {
                  const id = Number(l.order_item_id);
                  const dv = dvByLine[id] || { carrier: '', tracking: '' };
                  const checked = directChecked.has(id);
                  return (
                    <div key={l.order_item_id} className="px-2 py-1.5 space-y-1.5">
                      <label className="flex items-center gap-2 text-xs cursor-pointer">
                        <input type="checkbox" checked={checked}
                          onChange={e => setDirectChecked(s => { const n = new Set(s); if (e.target.checked) n.add(id); else n.delete(id); return n; })} />
                        <span className="font-medium">{l.sku_code}</span>
                        <span className="text-muted-foreground">× {fmtNum(Number(l.effective_qty))}</span>
                      </label>
                      {checked && (
                        <div className="flex flex-wrap gap-1.5 pl-6">
                          <Input placeholder="Carrier" value={dv.carrier}
                            onChange={e => setDvByLine(m => ({ ...m, [id]: { ...(m[id] || { carrier: '', tracking: '' }), carrier: e.target.value } }))}
                            className="h-7 w-28 text-xs" />
                          <Input placeholder="Tracking (optional)" value={dv.tracking}
                            onChange={e => setDvByLine(m => ({ ...m, [id]: { ...(m[id] || { carrier: '', tracking: '' }), tracking: e.target.value } }))}
                            className="h-7 flex-1 min-w-36 text-xs font-mono" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {directMsg && <p className="text-xs text-red-600">{directMsg}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDirecting(null)}>Cancel</Button>
              <Button size="sm" disabled={directBusy || directLinesLoading || directChecked.size === 0} onClick={runVendorShipped}>
                {directBusy ? 'Marking…' : `Mark ${directChecked.size} line${directChecked.size === 1 ? '' : 's'} vendor shipped`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* adopt-upstream dialog: turns the ordering app's shipped facts
          into a local finalized shipment (no tracking) so those
          quantities leave "remaining to pack" */}
      <Dialog open={!!adopting} onOpenChange={o => { if (!o) setAdopting(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Record upstream shipment — {adopting?.order_number}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              The ordering app marks {adoptFull ? <>this order <span className="font-semibold">"{adoptInfo?.status}"</span></> : <>these items shipped</>}.
              Recording creates a finalized local shipment (carrier "upstream", <span className="font-semibold">no tracking</span>) so these
              quantities leave "remaining to pack" and cannot be shipped again. If you have the real carrier + tracking, use Ship &gt; manual entry instead.
            </p>
            {adoptLinesLoading && <p className="text-xs text-muted-foreground">Loading items…</p>}
            {!adoptLinesLoading && adoptLines.length === 0 && (
              <p className="text-xs text-amber-700">Nothing to record — every matching item is already covered by a local shipment or draft.</p>
            )}
            {adoptLines.length > 0 && (
              <div className="border rounded-lg divide-y">
                {adoptLines.map(l => (
                  <div key={l.order_item_id} className="flex items-center gap-2 px-2 py-1.5 text-xs">
                    <span className="font-medium">{l.sku_code}</span>
                    <span className="text-muted-foreground">× {fmtNum(Number(l.adopt_qty))}</span>
                    {l.clamped && <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1 py-0.5" title={`Upstream shipped less than the local remaining ${fmtNum(Number(l.remaining_qty))} — only the upstream-shipped quantity is recorded`}>of {fmtNum(Number(l.remaining_qty))}</span>}
                    <span className="ml-auto text-muted-foreground">{l.date ? `shipped upstream ${l.date}` : `order marked ${adoptInfo?.status}`}</span>
                  </div>
                ))}
              </div>
            )}
            {adoptComputed.ambiguous.length > 0 && (
              <p className="text-xs text-amber-700">
                Not recordable automatically (conflicting upstream dates or unusable quantities): {adoptComputed.ambiguous.join(', ')} — record {adoptComputed.ambiguous.length > 1 ? 'these' : 'it'} via Ship &gt; manual entry.
              </p>
            )}
            {undatedCount > 0 && (
              <label className="flex items-start gap-1.5 text-xs text-amber-800 cursor-pointer">
                <input type="checkbox" className="mt-0.5" checked={adoptConfirmed} onChange={e => setAdoptConfirmed(e.target.checked)} />
                <span>{undatedCount} item{undatedCount > 1 ? 's have' : ' has'} no per-item shipped date — only the order-level "{adoptInfo?.status}" status covers {undatedCount > 1 ? 'them' : 'it'}. I confirm these items really shipped.</span>
              </label>
            )}
            {adoptMsg && <p className="text-xs text-red-600">{adoptMsg}</p>}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAdopting(null)}>Cancel</Button>
              <Button size="sm" disabled={adoptBusy || adoptLinesLoading || adoptLines.length === 0 || (undatedCount > 0 && !adoptConfirmed)} onClick={runAdopt}>
                {adoptBusy ? 'Recording…' : `Record ${adoptLines.length} item${adoptLines.length === 1 ? '' : 's'} as shipped`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
