import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import listProducts from '@/actions/products/listProducts';
import listActiveExternalOrders from '@/actions/orders/listActiveExternalOrders';
import cancelDeletedUpstream from '@/actions/orders/cancelDeletedUpstream';
import { useApp } from '@/app/AppContext';
import { useImportRunner, importSourceKey } from '@/app/ImportRunner';
import { rows } from '@/lib/rows';
import { fmtUSD } from '@/lib/fmt';
import { parseOrderPaste, ParseResult } from '@/lib/parseOrderImport';
import { B44_DEFAULT_APP_ID, B44Order, b44OrderExists, listB44Orders } from '@/lib/base44';
import { mapB44Orders, MappedOrders } from '@/lib/mapB44Order';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ClipboardPaste, CloudDownload, CheckCircle2, XCircle } from 'lucide-react';

type CampaignProduct = { sku_code: string };
type CatalogProduct = { external_id: string | null; sku_code: string };
type LocalExtOrder = { id: number; order_number: string; external_id: string; contact_name: string | null; total_usd: string };

const EMPTY_RESULT: ParseResult = { orders: [], errors: [] };

export function ImportPage() {
  const { groupBuyId, groupBuy, settings, userName } = useApp();
  const [text, setText] = useState('');
  // The import itself runs in the app-level ImportRunner so it survives
  // navigation; this page just starts it and renders its progress. Results
  // render only while the CURRENT parsed input matches the job's content
  // snapshot — editing the paste or re-pulling different data must not show
  // stale green rows under the same order numbers (computed below, after
  // the input is parsed).
  const { job, startImport } = useImportRunner();
  const importing = job.running;

  const enabled = groupBuyId != null;
  const [rawProducts] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const campaignSkus = useMemo(
    () => new Set(rows<CampaignProduct>(rawProducts).map(p => p.sku_code)),
    [rawProducts],
  );
  const [rawCatalog, catalogLoading] = useLoadAction(listProducts, [], {});
  const skuByExternalId = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of rows<CatalogProduct>(rawCatalog)) {
      if (p.external_id) m.set(p.external_id, p.sku_code);
    }
    return m;
  }, [rawCatalog]);

  const [doCancelDeleted] = useMutateAction(cancelDeletedUpstream);
  const [rawLocalExt, , , reloadLocalExt] = useLoadAction(
    listActiveExternalOrders,
    [groupBuyId, groupBuy?.external_id],
    { group_buy_id: groupBuyId, gb_external_id: groupBuy?.external_id || '' },
    { enabled: enabled && !!groupBuy?.external_id },
  );

  // Ordering-app pull — same preview/import flow as paste, different source.
  const cfg = useMemo(() => ({
    appId: settings.base44_app_id || B44_DEFAULT_APP_ID,
    token: settings.base44_token || '',
  }), [settings.base44_app_id, settings.base44_token]);
  const canPull = !!cfg.token && !!groupBuy?.external_id;
  // Raw pulled orders stay bound to their FULL source identity — the local
  // campaign AND the ordering-app source that produced them (app id, external
  // campaign id, token). The snapshot goes inert the moment any of those
  // change (campaign relinked, settings edited), so a stale set can never
  // drive the deleted-upstream diff against a different source.
  const [pulled, setPulled] = useState<{ forGroupBuyId: number; appId: string; gbExternalId: string; token: string; orders: B44Order[] } | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullError, setPullError] = useState('');

  const pull = async () => {
    if (!canPull || !groupBuy?.external_id || groupBuyId == null) return;
    const source = { forGroupBuyId: groupBuyId, appId: cfg.appId, gbExternalId: groupBuy.external_id, token: cfg.token };
    setPulling(true); setPullError('');
    try {
      const orders = await listB44Orders(cfg, source.gbExternalId);
      setPulled({ ...source, orders });
      setText('');
    } catch (e: unknown) {
      setPullError(e instanceof Error ? e.message : 'Failed to pull orders');
    } finally {
      setPulling(false);
    }
  };

  // Snapshot is only usable while its source identity still matches the
  // current one — everything below consumes pulledFresh, never pulled.
  const pulledFresh = useMemo(
    () => (pulled
      && pulled.forGroupBuyId === groupBuyId
      && pulled.appId === cfg.appId
      && pulled.gbExternalId === (groupBuy?.external_id || '')
      && pulled.token === cfg.token
      ? pulled : null),
    [pulled, groupBuyId, cfg.appId, cfg.token, groupBuy?.external_id],
  );

  // Pull automatically once per campaign, only after the catalog has loaded —
  // the identity mapping is meaningless against an unloaded catalog.
  const autoPulledFor = useRef<number | null>(null);
  // A source change (relinked campaign, edited settings) invalidates the
  // snapshot above — also re-arm the auto-pull so a fresh one replaces it.
  useEffect(() => { autoPulledFor.current = null; }, [cfg.appId, cfg.token, groupBuy?.external_id]);
  useEffect(() => {
    if (canPull && !catalogLoading && groupBuyId != null && autoPulledFor.current !== groupBuyId) {
      autoPulledFor.current = groupBuyId;
      pull();
    }
  }, [canPull, catalogLoading, groupBuyId, cfg, groupBuy?.external_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pulledMapped = useMemo<MappedOrders | null>(
    () => (pulledFresh ? mapB44Orders(pulledFresh.orders, skuByExternalId) : null),
    [pulledFresh, skuByExternalId],
  );

  const parsed = useMemo(
    () => (text.trim() !== '' ? parseOrderPaste(text) : pulledMapped ?? EMPTY_RESULT),
    [text, pulledMapped],
  );

  // Pre-flight: every SKU in every order must exist as a campaign product,
  // otherwise line items would silently vanish at insert time.
  const skuProblems = useMemo(() => {
    const missing = new Map<string, string[]>();
    for (const o of parsed.orders) {
      for (const it of o.items) {
        if (!campaignSkus.has(it.sku)) {
          missing.set(it.sku, [...(missing.get(it.sku) || []), o.orderNumber]);
        }
      }
    }
    return missing;
  }, [parsed, campaignSkus]);

  // Upstream cancellations only apply when the pulled set is the active source.
  const cancellations = text.trim() === '' && pulledMapped ? pulledMapped.cancellations : [];

  // Orders DELETED upstream never appear in the pull at all (deletion has no
  // status), so they'd linger locally in demand/revenue forever. Diff the
  // pulled ids against active local orders that came from the ordering app.
  // Guards against false positives: only for a completed pull (listB44Orders
  // throws on any page error, so a returned set is fully paginated), only for
  // the campaign it was pulled for, only while the pull is the active source,
  // and never when the pull came back empty — an empty set alongside existing
  // local orders means a broken filter/token, not a mass deletion.
  const [deletedResults, setDeletedResults] = useState<Map<number, { busy?: boolean; ok?: boolean; message?: string }>>(new Map());
  useEffect(() => { setDeletedResults(new Map()); }, [groupBuyId, pulled]);
  const missingUpstream = useMemo<LocalExtOrder[]>(() => {
    if (text.trim() !== '' || !pulledFresh || pulledFresh.orders.length === 0) return [];
    const pulledIds = new Set(pulledFresh.orders.map(o => o.id));
    return rows<LocalExtOrder>(rawLocalExt).filter(o => !pulledIds.has(o.external_id));
  }, [text, pulledFresh, rawLocalExt]);

  // Cancelling is a human call (per-order click): a vanished id USUALLY means
  // deleted upstream, but the operator confirms. Cancelled orders drop out of
  // demand, recon, and P&L (views exclude them); the note records why.
  const markDeletedUpstream = async (m: LocalExtOrder) => {
    // Inert snapshot (source changed since the flag was computed) — refuse.
    if (!pulledFresh) return;
    setDeletedResults(prev => new Map(prev).set(m.id, { busy: true }));
    try {
      // The pulled snapshot that flagged this row may be stale — re-check the
      // specific order at click time. Only a definitive not-found proceeds;
      // auth/network errors throw and abort the cancel.
      if (await b44OrderExists(cfg, m.external_id)) {
        setDeletedResults(prev => new Map(prev).set(m.id, { ok: false, message: 'Still exists in the ordering app — pull again to refresh this list.' }));
        return;
      }
      const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
      // One atomic action: status + note + audit land together or not at all,
      // and a retry against an already-cancelled order writes nothing twice.
      const res = await doCancelDeleted({
        order_id: m.id,
        group_buy_id: groupBuyId,
        gb_external_id: pulledFresh.gbExternalId,
        note: `${ts} marked cancelled: order no longer exists in the ordering app (deleted upstream).`,
        actor: userName,
        external_id: m.external_id,
      }) as { id: number }[] | { id: number } | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      setDeletedResults(prev => new Map(prev).set(m.id, { ok: true, message: touched ? 'marked cancelled' : 'already cancelled' }));
      reloadLocalExt();
    } catch (e: unknown) {
      setDeletedResults(prev => new Map(prev).set(m.id, { ok: false, message: e instanceof Error ? e.message : 'Failed to cancel' }));
    }
  };

  const statusCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const o of parsed.orders) {
      const s = o.status || 'unknown';
      m.set(s, (m.get(s) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [parsed]);

  const sourceKey = useMemo(
    () => (groupBuyId == null ? null : importSourceKey({ groupBuyId, orders: parsed.orders, cancellations })),
    [groupBuyId, parsed.orders, cancellations],
  );
  const results = sourceKey != null && job.sourceKey === sourceKey ? job.results : [];

  const canImport = enabled && (parsed.orders.length > 0 || cancellations.length > 0) && skuProblems.size === 0 && !importing;

  const runImport = () => {
    if (!canImport || groupBuyId == null) return;
    // Hands the validated set to the app-level runner and returns
    // immediately — progress renders below and in the floating widget.
    startImport({ groupBuyId, orders: parsed.orders, cancellations });
  };

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ClipboardPaste className="h-6 w-6 text-violet-600" /> Import Orders
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Orders for <span className="font-medium">{groupBuy?.name}</span> pull straight from the ordering app;
          the paste box below stays as a fallback. Re-importing the same orders is safe — they update in place, they don't duplicate.
        </p>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Button size="sm" onClick={pull} disabled={!canPull || pulling}>
              <CloudDownload className="w-4 h-4 mr-1" />
              {pulling ? 'Pulling…' : 'Pull from ordering app'}
            </Button>
            {!canPull && (
              <p className="text-sm text-muted-foreground">
                Needs the ordering-app JWT (Settings) and a linked campaign (Products → Ordering app).
              </p>
            )}
            {pulledMapped && text.trim() === '' && !pulling && (
              <p className="text-sm text-muted-foreground">
                {pulledMapped.orders.length} orders pulled from the ordering app
                {pulledMapped.cancellations.length > 0 ? `, ${pulledMapped.cancellations.length} upstream cancellation(s)` : ''}
                {pulledMapped.errors.length > 0 ? `, ${pulledMapped.errors.length} skipped` : ''}.
                {statusCounts.length > 0 && (
                  <span className="block text-xs mt-0.5">
                    Source statuses: {statusCounts.map(([s, n]) => `${s}: ${n}`).join(', ')}
                  </span>
                )}
              </p>
            )}
          </div>
          {pullError && <p className="text-sm text-red-600">{pullError}</p>}
        </CardContent>
      </Card>

      <Textarea
        placeholder="Or paste order rows here (overrides the pulled set while non-empty)…"
        value={text}
        onChange={e => setText(e.target.value)}
        rows={6}
        className="font-mono text-xs"
      />

      {(text.trim() !== '' || pulledMapped) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Preview — {parsed.orders.length} orders parsed
              {parsed.errors.length > 0 && <span className="text-red-600">, {parsed.errors.length} rows rejected</span>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {parsed.errors.length > 0 && (
              <div className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800 space-y-1">
                {parsed.errors.map((e, i) => (
                  <div key={i}><span className="font-mono">line {e.line}</span>: {e.reason} — <span className="font-mono text-xs">{e.text}</span></div>
                ))}
              </div>
            )}
            {cancellations.length > 0 && (
              <div className="rounded border border-orange-300 bg-orange-50 p-2 text-sm text-orange-900 space-y-1">
                <p className="font-semibold">Cancelled/refunded upstream — importing will update their local status (views already exclude them from demand and revenue):</p>
                {cancellations.map(c => {
                  const res = results.find(r => r.orderNumber === c.orderNumber);
                  return (
                    <div key={c.orderNumber}>
                      <span className="font-mono">{c.orderNumber}</span> → {c.status} <span className="text-xs">({c.sourceStatus})</span>
                      {res && <span className={`text-xs ml-2 ${res.ok ? 'text-green-700' : 'text-red-600'}`}>{res.message}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {missingUpstream.length > 0 && (
              <div className="rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-900 space-y-1">
                <p className="font-semibold">
                  Deleted upstream? — {missingUpstream.length} active local order(s) no longer exist in the ordering app.
                  Review each and mark cancelled if the deletion was intentional (drops it from demand, reconciliation, and P&L):
                </p>
                {missingUpstream.map(m => {
                  const r = deletedResults.get(m.id);
                  return (
                    <div key={m.id} className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono">{m.order_number}</span>
                      <span>{m.contact_name}</span>
                      <span className="text-xs">{fmtUSD(Number(m.total_usd))}</span>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={r?.busy || r?.ok} onClick={() => markDeletedUpstream(m)}>
                        {r?.busy ? 'Cancelling…' : 'Mark cancelled'}
                      </Button>
                      {r?.message && <span className={`text-xs ${r.ok ? 'text-green-700' : 'text-red-600'}`}>{r.message}</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {skuProblems.size > 0 && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">
                <p className="font-semibold">Unknown SKUs — add these as campaign products first (Products page):</p>
                {[...skuProblems.entries()].map(([sku, ords]) => (
                  <div key={sku}><span className="font-mono">{sku}</span> — in {ords.length} order(s): {ords.slice(0, 5).join(', ')}{ords.length > 5 ? '…' : ''}</div>
                ))}
              </div>
            )}
            <div className="border rounded overflow-x-auto max-h-96 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Order #</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Rail</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead>Tx refs</TableHead>
                    <TableHead>Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {parsed.orders.map(o => {
                    const res = results.find(r => r.orderNumber === o.orderNumber);
                    return (
                      <TableRow key={o.orderNumber}>
                        <TableCell className="font-medium">{o.orderNumber}</TableCell>
                        <TableCell>{o.customerName}</TableCell>
                        <TableCell>{o.paymentRail}</TableCell>
                        <TableCell className="text-xs max-w-[220px] truncate">
                          {o.items.map(i => `${i.sku} (${i.qty})`).join('; ')}
                        </TableCell>
                        <TableCell className="text-right">{fmtUSD(o.total)}</TableCell>
                        <TableCell className="text-center">{o.payments.length}</TableCell>
                        <TableCell>
                          {res && (res.ok
                            ? <span className="text-green-700 text-xs flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" />{res.message}</span>
                            : <span className="text-red-600 text-xs flex items-center gap-1"><XCircle className="w-3.5 h-3.5" />{res.message}</span>)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <Button onClick={runImport} disabled={!canImport}>
              {importing
                ? `Importing… (${results.length}/${parsed.orders.length + cancellations.length})`
                : `Import ${parsed.orders.length} orders${cancellations.length > 0 ? ` + apply ${cancellations.length} cancellation(s)` : ''}`}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
