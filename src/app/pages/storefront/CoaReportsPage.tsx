import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listStorefrontCoaProducts from '@/actions/storefront/listStorefrontCoaProducts';
import listStorefrontCoaReports from '@/actions/storefront/listStorefrontCoaReports';
import addStorefrontCoaReport from '@/actions/storefront/addStorefrontCoaReport';
import updateStorefrontCoaReport from '@/actions/storefront/updateStorefrontCoaReport';
import deleteStorefrontCoaReport from '@/actions/storefront/deleteStorefrontCoaReport';
import { useApp, platformOf } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtDate } from '@/lib/fmt';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FlaskConical, ExternalLink, Plus } from 'lucide-react';

/**
 * Lab reports (COAs) for the selected campaign's lines, kept in
 * storefront.coa_reports for p2collective.app's COA library. A report is a
 * link to the lab-hosted COA; PDF upload is not handled here. Every write is
 * one row, audited, and edits/deletes are version-checked so a stale tab is
 * refused instead of overwriting another admin's change.
 */

type ProductRow = {
  group_buy_product_id: number;
  product_id: number;
  sku_code: string;
  product_name: string;
  mass_label: string | null;
  /** COA add-on lines (the testing purchase itself) are digital products */
  digital: boolean;
  status: string;
  report_count: string;
};
type ReportRow = {
  id: number;
  group_buy_product_id: number;
  lab: string | null;
  report_url: string | null;
  media_id: number | null;
  batch_label: string | null;
  /** YYYY-MM-DD (to_char), never a timestamp — formatted without a timezone shift */
  tested_at: string | null;
  purity_pct: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  listing_count: string;
  /** digest of the stored columns as loaded; edit/delete hand it back */
  version: string;
};

type Draft = { lab: string; reportUrl: string; batchLabel: string; testedAt: string; purityPct: string; notes: string };
const EMPTY_DRAFT: Draft = { lab: '', reportUrl: '', batchLabel: '', testedAt: '', purityPct: '', notes: '' };
type Editing = { mode: 'add'; gbpId: number } | { mode: 'edit'; report: ReportRow };

// mirror the action's checks so the page explains a refusal before sending it
const URL_RE = /^https?:\/\/[^/\s]+([/?#]\S*)?$/i;
const PURITY_RE = /^\d{1,3}(\.\d{1,2})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function draftProblem(d: Draft, hasPdf: boolean): string | null {
  const url = d.reportUrl.trim();
  if (!url) {
    if (!hasPdf) return 'Enter the link to the lab-hosted report (http:// or https://).';
  } else if (url.length > 2000 || !URL_RE.test(url)) {
    return 'The report link must be a web address starting with http:// or https://, with no spaces.';
  }
  const p = d.purityPct.trim();
  if (p && (!PURITY_RE.test(p) || Number(p) > 100)) return 'Purity is a percentage from 0 to 100 with at most two decimals, e.g. 99.12.';
  if (d.testedAt && !DATE_RE.test(d.testedAt)) return 'Tested on must be a date.';
  return null;
}

/** "2026-10-01" → "Oct 1, 2026" in local terms (new Date('YYYY-MM-DD') would be UTC midnight). */
function fmtYmd(v: string | null): string {
  if (!v || !DATE_RE.test(v)) return '—';
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function hostOf(u: string): string {
  try { return new URL(u).host; } catch { return u; }
}

// success copy is fixed; anything else on the page is a problem to fix
const isOk = (m: string) => /^Report (added|saved|deleted)\.$/.test(m);

export function CoaReportsPage() {
  const { groupBuyId, groupBuy, userName } = useApp();
  const enabled = groupBuyId != null;

  const [rawProducts, productsLoading, productsError, reloadProducts] = useLoadAction(listStorefrontCoaProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const products = rows<ProductRow>(rawProducts);
  const [rawReports, reportsLoading, reportsError, reloadReports] = useLoadAction(listStorefrontCoaReports, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const reports = rows<ReportRow>(rawReports);

  const [doAdd] = useMutateAction(addStorefrontCoaReport);
  const [doUpdate] = useMutateAction(updateStorefrontCoaReport);
  const [doDelete] = useMutateAction(deleteStorefrontCoaReport);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formMsg, setFormMsg] = useState('');
  const [pageMsg, setPageMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<ReportRow | null>(null);
  const [showAddOns, setShowAddOns] = useState(false);

  // a campaign switch drops any half-made edit — it belonged to the other campaign's lines
  useEffect(() => {
    setEditing(null); setConfirmDelete(null); setFormMsg(''); setPageMsg('');
  }, [groupBuyId]);

  const reportsByLine = useMemo(() => {
    const m = new Map<number, ReportRow[]>();
    for (const r of reports) {
      const k = Number(r.group_buy_product_id);
      const list = m.get(k);
      if (list) list.push(r); else m.set(k, [r]);
    }
    return m;
  }, [reports]);

  // COA add-on lines are the testing purchase, not the product tested: listed
  // only on request, or when a report was already attached to one
  const addOnCount = products.filter(p => p.digital).length;
  const visible = products.filter(p => !p.digital || showAddOns || Number(p.report_count) > 0);

  const reloadAll = () => { reloadReports(); reloadProducts(); };

  const startAdd = (gbpId: number) => {
    setEditing({ mode: 'add', gbpId }); setDraft(EMPTY_DRAFT); setFormMsg(''); setPageMsg(''); setConfirmDelete(null);
  };
  const startEdit = (r: ReportRow) => {
    setEditing({ mode: 'edit', report: r });
    setDraft({
      lab: r.lab ?? '', reportUrl: r.report_url ?? '', batchLabel: r.batch_label ?? '',
      testedAt: r.tested_at ?? '', purityPct: r.purity_pct != null ? String(Number(r.purity_pct)) : '', notes: r.notes ?? '',
    });
    setFormMsg(''); setPageMsg(''); setConfirmDelete(null);
  };
  const cancelEdit = () => { setEditing(null); setFormMsg(''); };

  const save = async () => {
    if (groupBuyId == null || !editing) return;
    const hasPdf = editing.mode === 'edit' && editing.report.media_id != null;
    const problem = draftProblem(draft, hasPdf);
    if (problem) { setFormMsg(problem); return; }
    setBusy(true); setFormMsg('');
    try {
      const fields = {
        group_buy_id: groupBuyId,
        lab: draft.lab.trim(),
        report_url: draft.reportUrl.trim(),
        batch_label: draft.batchLabel.trim(),
        tested_at: draft.testedAt,
        purity_pct: draft.purityPct.trim(),
        notes: draft.notes.trim(),
        actor: userName,
      };
      const res = (editing.mode === 'add'
        ? await doAdd({ ...fields, group_buy_product_id: editing.gbpId })
        : await doUpdate({ ...fields, id: editing.report.id, expected_version: editing.report.version })) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      if (!touched) {
        setFormMsg(editing.mode === 'add'
          ? 'Refused: that line is no longer in this campaign, or a field failed the server check. Reload the page and try again.'
          : 'Refused: this report changed since you loaded it (another admin or tab). Reload the page and reapply your edits.');
        return;
      }
      setPageMsg(editing.mode === 'add' ? 'Report added.' : 'Report saved.');
      setEditing(null);
      reloadAll();
    } catch (e: unknown) {
      setFormMsg(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (r: ReportRow) => {
    if (groupBuyId == null) return;
    setBusy(true); setPageMsg('');
    try {
      const res = await doDelete({ id: r.id, group_buy_id: groupBuyId, expected_version: r.version, actor: userName }) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      setPageMsg(touched
        ? 'Report deleted.'
        : Number(r.listing_count) > 0
          ? 'Refused: a P² store listing cites this report. Listings are managed in the P2 Collective Orders app.'
          : 'Refused: this report changed since you loaded it (another admin or tab). The list is reloaded; check it and delete again if still wanted.');
      reloadAll();
    } catch (e: unknown) {
      setPageMsg(e instanceof Error ? e.message : 'Failed to delete');
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  if (!enabled) return <div className="p-6 text-sm text-muted-foreground">Pick a campaign first.</div>;

  const loadError = productsError ?? reportsError;
  const editingLine = editing ? (editing.mode === 'add' ? editing.gbpId : Number(editing.report.group_buy_product_id)) : null;
  const hasPdf = editing?.mode === 'edit' && editing.report.media_id != null;

  const renderForm = (lineName: string) => (
    <div className="border-t bg-muted/20 p-3 space-y-3">
      <p className="text-sm font-semibold">{editing?.mode === 'edit' ? 'Edit report' : 'New report'} · {lineName}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="coa-url">Report link</Label>
          <Input id="coa-url" value={draft.reportUrl} onChange={e => setDraft({ ...draft, reportUrl: e.target.value })} placeholder="https://…" inputMode="url" className="font-mono text-xs" />
          <p className="text-xs text-muted-foreground">{hasPdf ? 'A PDF is on file for this report, so the link may be left empty.' : 'The lab-hosted COA, http:// or https://.'}</p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="coa-lab">Lab</Label>
          <Input id="coa-lab" value={draft.lab} onChange={e => setDraft({ ...draft, lab: e.target.value })} placeholder="e.g. Janoshik" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="coa-batch">Batch</Label>
          <Input id="coa-batch" value={draft.batchLabel} onChange={e => setDraft({ ...draft, batchLabel: e.target.value })} placeholder="Lot or batch on the vial" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="coa-tested">Tested on</Label>
          <Input id="coa-tested" type="date" value={draft.testedAt} onChange={e => setDraft({ ...draft, testedAt: e.target.value })} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="coa-purity">Purity %</Label>
          <Input id="coa-purity" value={draft.purityPct} onChange={e => setDraft({ ...draft, purityPct: e.target.value.replace(/[^\d.]/g, '') })} inputMode="decimal" placeholder="e.g. 99.12" className="font-mono" />
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="coa-notes">Notes</Label>
          <Textarea id="coa-notes" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} rows={2} />
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : editing?.mode === 'edit' ? 'Save report' : 'Add report'}</Button>
        <Button size="sm" variant="outline" onClick={cancelEdit} disabled={busy}>Cancel</Button>
        {formMsg && <span className={`text-sm ${isOk(formMsg) ? 'text-emerald-300' : 'text-rose-400'}`}>{formMsg}</span>}
      </div>
    </div>
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2 text-gradient">
          <FlaskConical className="h-6 w-6 text-cyan-300" /> COA Reports
        </h1>
        <p className="text-base mt-2">
          Reports for: <span className="font-semibold">{groupBuy?.name ?? '— no campaign selected —'}</span>
          {groupBuy && <span className="ml-2 align-middle text-xs rounded border px-1.5 py-0.5 text-muted-foreground">{platformOf(groupBuy)}</span>}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          Lab reports for this campaign's products, linked from the lab's own site and kept for p2collective.app's COA library. The campaign comes from the header switcher; its products are set up on <Link to="/products" className="text-cyan-300 hover:underline">Products</Link>.
        </p>
      </div>

      {pageMsg && <p className={`text-sm ${isOk(pageMsg) ? 'text-emerald-300' : 'text-rose-400'}`}>{pageMsg}</p>}
      {loadError && <p className="text-sm text-rose-400">Could not load reports: {loadError.message}</p>}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between gap-3 flex-wrap">
            <span>Products</span>
            {addOnCount > 0 && (
              <button type="button" className="text-xs font-normal text-cyan-300 hover:underline" onClick={() => setShowAddOns(s => !s)}>
                {showAddOns ? 'Hide' : 'Show'} COA add-on lines ({addOnCount})
              </button>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {(productsLoading || reportsLoading) && products.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!productsLoading && !loadError && products.length === 0 && (
            <p className="text-sm text-muted-foreground">This campaign has no products yet. Add them on <Link to="/products" className="text-cyan-300 hover:underline">Products</Link> first.</p>
          )}
          {visible.map(p => {
            const lineId = Number(p.group_buy_product_id);
            const lineReports = reportsByLine.get(lineId) ?? [];
            const lineName = `${p.product_name}${p.mass_label ? ` ${p.mass_label}` : ''}`;
            return (
              <div key={lineId} className="border rounded overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{lineName}</p>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {p.sku_code}{p.digital ? ' · COA add-on' : ''}{p.status !== 'active' ? ` · ${p.status}` : ''}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => startAdd(lineId)} disabled={busy || (editing?.mode === 'add' && editing.gbpId === lineId)}>
                    <Plus /> Add report
                  </Button>
                </div>
                {lineReports.length === 0 ? (
                  <p className="px-3 pb-2 text-xs text-muted-foreground">No report yet.</p>
                ) : (
                  <div className="border-t overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Lab</TableHead>
                          <TableHead>Batch</TableHead>
                          <TableHead>Tested</TableHead>
                          <TableHead className="text-right">Purity</TableHead>
                          <TableHead>Report</TableHead>
                          <TableHead>Notes</TableHead>
                          <TableHead>Added</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {lineReports.map(r => {
                          const cited = Number(r.listing_count) > 0;
                          return (
                            <TableRow key={r.id}>
                              <TableCell>{r.lab || '—'}</TableCell>
                              <TableCell className="font-mono text-xs">{r.batch_label || '—'}</TableCell>
                              <TableCell className="whitespace-nowrap">{fmtYmd(r.tested_at)}</TableCell>
                              <TableCell className="text-right font-mono text-xs">{r.purity_pct != null ? `${Number(r.purity_pct)}%` : '—'}</TableCell>
                              <TableCell className="text-xs">
                                {r.report_url ? (
                                  <a href={r.report_url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline inline-flex items-center gap-1 max-w-[200px]" title={r.report_url}>
                                    <span className="truncate">{hostOf(r.report_url)}</span> <ExternalLink className="w-3 h-3 shrink-0" />
                                  </a>
                                ) : r.media_id != null ? <span className="text-muted-foreground">PDF on file</span> : '—'}
                              </TableCell>
                              <TableCell className="text-xs max-w-[220px] truncate" title={r.notes ?? ''}>{r.notes || '—'}</TableCell>
                              <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{r.created_by || '—'} · {fmtDate(r.created_at)}</TableCell>
                              <TableCell className="text-right whitespace-nowrap">
                                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={() => startEdit(r)}>Edit</Button>
                                {cited ? (
                                  // the listing's foreign key keeps the report; listings live in the P2 Collective Orders app
                                  <span className="text-xs text-muted-foreground px-2">Cited by a store listing</span>
                                ) : (
                                  <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-400" disabled={busy}
                                    onClick={() => { setConfirmDelete(r); setEditing(null); setPageMsg(''); }}>
                                    Delete
                                  </Button>
                                )}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
                {confirmDelete && Number(confirmDelete.group_buy_product_id) === lineId && (
                  <div className="border-t border-amber-400/40 bg-amber-400/5 p-3 text-sm space-y-2">
                    <p className="font-semibold text-amber-200">Delete the {confirmDelete.lab || 'unnamed lab'} report for {lineName}?</p>
                    <p>
                      {confirmDelete.batch_label ? `Batch ${confirmDelete.batch_label}, ` : ''}tested {fmtYmd(confirmDelete.tested_at)}
                      {confirmDelete.purity_pct != null ? `, ${Number(confirmDelete.purity_pct)}% purity` : ''}. It is removed from the COA library for good; the audit log keeps a copy of what it said.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => remove(confirmDelete)}>{busy ? 'Deleting…' : 'Delete report'}</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelete(null)}>Keep</Button>
                    </div>
                  </div>
                )}
                {editingLine === lineId && renderForm(lineName)}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
