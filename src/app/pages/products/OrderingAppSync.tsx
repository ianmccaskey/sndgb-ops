import React, { useEffect, useMemo, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import saveProduct from '@/actions/products/saveProduct';
import linkCampaignProduct from '@/actions/products/linkCampaignProduct';
import linkGroupBuyExternal from '@/actions/groupBuys/linkGroupBuyExternal';
import { useApp } from '@/app/AppContext';
import {
  B44_DEFAULT_APP_ID, B44GroupBuy, B44Product,
  listB44GroupBuys, listB44Products, scopeProductsToGroupBuy,
} from '@/lib/base44';
import { fmtUSD } from '@/lib/fmt';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { CloudDownload, Link2 } from 'lucide-react';

type ExistingProduct = { id: number; sku_code: string; name: string };

/** One row of listCampaignProductLinks — the selected campaign's links. */
export type CampaignProductLink = { group_buy_id: number | string; product_id: number | string; external_id: string; sku_code: string };

type PreviewRow = {
  include: boolean;
  b44: B44Product;
  match: ExistingProduct | null;
  /** this campaign's link state for the row, shown before importing */
  linkState: 'linked' | 'new' | 'other';
};

type LinkOutcome = { outcome?: string; ext_holder_sku?: string | null; current_external_id?: string | null };

/*
 * Product sync for the SELECTED campaign. Ordering-app ids are linked per
 * campaign (campaign_product_links, 1790101900): base44 keeps a separate
 * Product record per group buy, so syncing one campaign must never move
 * another campaign's links — the single products.external_id it used to
 * overwrite did exactly that (Elora & More's sync broke Mixed Buy #5's
 * imports). products.external_id is no longer written here.
 */
export function OrderingAppSync({ products, links, onImported }: {
  products: ExistingProduct[];
  links: CampaignProductLink[];
  onImported: () => void;
}) {
  const { groupBuy, settings, reloadGroupBuys, userName } = useApp();
  const [doSaveProduct] = useMutateAction(saveProduct);
  const [doLinkProduct] = useMutateAction(linkCampaignProduct);
  const [doLinkGb] = useMutateAction(linkGroupBuyExternal);

  const cfg = useMemo(() => ({
    appId: settings.base44_app_id || B44_DEFAULT_APP_ID,
    token: settings.base44_token || '',
  }), [settings.base44_app_id, settings.base44_token]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [b44Buys, setB44Buys] = useState<B44GroupBuy[] | null>(null);
  const [pickedB44Id, setPickedB44Id] = useState('');
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  // the campaign + ordering-app buy a preview was pulled for: its links may
  // only ever be written to that campaign
  const [previewFor, setPreviewFor] = useState<{ gbId: number; gbExternalId: string } | null>(null);
  const [unscoped, setUnscoped] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');
  const [linkProblems, setLinkProblems] = useState<string[]>([]);

  // a preview pulled for one campaign is meaningless for another
  useEffect(() => {
    setPreview(null); setPreviewFor(null); setDoneMsg(''); setLinkProblems([]);
  }, [groupBuy?.id, groupBuy?.external_id]);

  if (!cfg.token) {
    return (
      <Card className="max-w-3xl">
        <CardHeader className="pb-2"><CardTitle className="text-base">Ordering app sync</CardTitle></CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Enter the ordering app JWT on the <span className="font-medium">Settings</span> page
            (Ordering app section) to enable pulling products for the current campaign.
          </p>
        </CardContent>
      </Card>
    );
  }

  const linked = !!groupBuy?.external_id;

  const loadBuys = async () => {
    setBusy(true); setError('');
    try {
      const buys = await listB44GroupBuys(cfg);
      setB44Buys(buys);
      const active = buys.find(b => b.status === 'active');
      if (active) setPickedB44Id(active.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load group buys');
    } finally {
      setBusy(false);
    }
  };

  const saveLink = async () => {
    if (!groupBuy || !pickedB44Id) return;
    setBusy(true); setError('');
    try {
      const res = await doLinkGb({ id: groupBuy.id, external_id: pickedB44Id }) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      if (!touched) {
        // a campaign runs on ONE ordering platform (1790101100): one set up
        // for the storefront is never linked to base44
        setError('Refused: this campaign is set up for the storefront (Campaign Setup), so it cannot also be linked to the ordering app.');
        return;
      }
      reloadGroupBuys();
      setB44Buys(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to link');
    } finally {
      setBusy(false);
    }
  };

  const pull = async () => {
    if (!groupBuy?.external_id) return;
    const target = { gbId: groupBuy.id, gbExternalId: groupBuy.external_id };
    setBusy(true); setError(''); setDoneMsg(''); setLinkProblems([]);
    try {
      const all = await listB44Products(cfg);
      const scoped = scopeProductsToGroupBuy(all, target.gbExternalId);
      setUnscoped(scoped === null);
      const list = scoped ?? all;
      // only this campaign's links, never a row left over from another one
      const mine = links.filter(l => Number(l.group_buy_id) === target.gbId);
      setPreview(list.map(p => {
        const name = String(p.name ?? '').trim();
        // this campaign's link first; the name only for a record not linked yet
        const linked = mine.find(l => l.external_id === p.id);
        const match =
          (linked ? products.find(x => Number(x.id) === Number(linked.product_id)) : undefined) ||
          products.find(x => x.sku_code.toLowerCase() === name.toLowerCase() || x.name.toLowerCase() === name.toLowerCase()) ||
          null;
        const linkState: PreviewRow['linkState'] = linked
          ? 'linked'
          : match && mine.some(l => Number(l.product_id) === Number(match.id)) ? 'other' : 'new';
        return { include: !!name, b44: p, match, linkState };
      }));
      setPreviewFor(target);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to pull products');
    } finally {
      setBusy(false);
    }
  };

  const importRows = async () => {
    if (!preview || !previewFor) return;
    // never write one campaign's ordering-app records as another's links
    if (!groupBuy || groupBuy.id !== previewFor.gbId || groupBuy.external_id !== previewFor.gbExternalId) {
      setError('The campaign changed since this preview was pulled — pull again.');
      setPreview(null); setPreviewFor(null);
      return;
    }
    const targetName = groupBuy.name;
    setBusy(true); setError(''); setDoneMsg(''); setLinkProblems([]);
    let created = 0, updated = 0, linkedNew = 0, linkedSame = 0, relinked = 0;
    const problems: string[] = [];
    try {
      for (const row of preview) {
        if (!row.include) continue;
        const name = String(row.b44.name ?? '').trim();
        if (!name) continue;
        const sku = row.match ? row.match.sku_code : name;
        const saved = await doSaveProduct({
          // SKU must match how the ordering app writes items in exports, which
          // is the product name — existing rows keep their curated SKU because
          // the upsert conflicts on sku_code via the matched product.
          sku_code: sku,
          name,
          mass_label: '',
          // blank = keep the frozen legacy column; the link is written below
          // for THIS campaign only
          external_id: '',
          // blank = keep any curated weight (saveProduct is set-if-provided)
          unit_weight_oz: '',
          active: true,
        }) as { id?: number | string }[] | { id?: number | string } | null;
        const productId = Array.isArray(saved) ? saved[0]?.id : saved?.id;
        if (productId == null) { problems.push(`${sku}: the product could not be saved, so it was not linked`); continue; }
        if (row.match) updated++; else created++;
        const res = await doLinkProduct({
          group_buy_id: previewFor.gbId, product_id: productId, external_id: row.b44.id, actor: userName,
        }) as LinkOutcome[] | LinkOutcome | null;
        const r = (Array.isArray(res) ? res[0] : res) ?? {};
        switch (r.outcome) {
          case 'linked': linkedNew++; break;
          case 'unchanged': linkedSame++; break;
          case 'relinked': relinked++; break;
          case 'ext_taken':
            problems.push(`${name}: this ordering-app product already stands for ${r.ext_holder_sku ?? 'another product'} in this campaign — not changed`);
            break;
          case 'product_linked':
            problems.push(`${sku}: already linked in this campaign to ordering-app product ${r.current_external_id ?? '?'}, which this campaign's orders use — not changed (two ordering-app records for one product)`);
            break;
          case 'conflict':
            problems.push(`${sku}: another sync changed this campaign's links at the same moment — pull again`);
            break;
          default:
            problems.push(`${sku}: link refused`);
        }
      }
      setDoneMsg(`Imported: ${created} new, ${updated} updated. Links for ${targetName}: ${linkedNew} new, ${linkedSame} already linked${relinked ? `, ${relinked} replaced (old record unused by any order)` : ''}.`);
      setLinkProblems(problems);
      setPreview(null); setPreviewFor(null);
      onImported();
    } catch (e: unknown) {
      setLinkProblems(problems);
      setError(e instanceof Error ? e.message : 'Import failed part-way — re-running is safe (upserts).');
      onImported();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="max-w-3xl">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-4 w-4" /> Campaign link — {groupBuy?.name}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {linked && !b44Buys && (
            <div className="flex items-center gap-3">
              <p className="text-sm">
                Linked to ordering-app buy <span className="font-mono text-xs">{groupBuy?.external_id}</span>
              </p>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={loadBuys} disabled={busy}>change</Button>
            </div>
          )}
          {!linked && !b44Buys && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                This campaign isn't linked to an ordering-app group buy yet — the link is what scopes every pull.
              </p>
              <Button size="sm" onClick={loadBuys} disabled={busy}>Load group buys from ordering app</Button>
            </div>
          )}
          {b44Buys && (
            <div className="flex flex-wrap items-center gap-2">
              <Select value={pickedB44Id} onValueChange={setPickedB44Id}>
                <SelectTrigger className="h-9 w-72"><SelectValue placeholder="Pick the matching group buy" /></SelectTrigger>
                <SelectContent>
                  {b44Buys.map(b => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.title || b.id}{b.abbreviation ? ` (${b.abbreviation})` : ''}{b.status ? ` — ${b.status}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={saveLink} disabled={busy || !pickedB44Id}>Link</Button>
              <Button size="sm" variant="ghost" onClick={() => setB44Buys(null)}>Cancel</Button>
            </div>
          )}
          {error && <p className="text-sm text-rose-400">{error}</p>}
        </CardContent>
      </Card>

      {linked && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CloudDownload className="h-4 w-4" /> Pull products for this campaign
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!preview && <Button size="sm" onClick={pull} disabled={busy}>{busy ? 'Pulling…' : 'Pull from ordering app'}</Button>}
            {preview && (
              <>
                {unscoped && (
                  <p className="text-sm text-amber-300">
                    The Product records have no group-buy field, so this is the <em>full</em> catalog —
                    untick anything that isn't part of {groupBuy?.name}.
                    (Fields seen: {Object.keys(preview[0]?.b44 || {}).join(', ')})
                  </p>
                )}
                <div className="border rounded-lg overflow-x-auto max-h-96 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8"></TableHead>
                        <TableHead>Ordering-app product</TableHead>
                        <TableHead className="text-right">GB price</TableHead>
                        <TableHead>Will</TableHead>
                        <TableHead>Ordering-app ID</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.map((row, i) => (
                        <TableRow key={row.b44.id}>
                          <TableCell>
                            <input
                              type="checkbox"
                              checked={row.include}
                              onChange={e => setPreview(p => p!.map((r, j) => j === i ? { ...r, include: e.target.checked } : r))}
                            />
                          </TableCell>
                          <TableCell className="font-medium">{String(row.b44.name ?? '(unnamed)')}</TableCell>
                          <TableCell className="text-right">{typeof row.b44.price === 'number' ? fmtUSD(row.b44.price) : '—'}</TableCell>
                          <TableCell>
                            <span className="flex flex-wrap items-center gap-1">
                              {row.match
                                ? <Badge variant="secondary">update “{row.match.sku_code}”</Badge>
                                : <Badge>create</Badge>}
                              {row.linkState === 'linked' && <span className="text-[11px] text-muted-foreground">already linked</span>}
                              {row.linkState === 'new' && <span className="text-[11px] text-muted-foreground">will link</span>}
                              {row.linkState === 'other' && (
                                <span className="text-[11px] text-amber-300" title="This product is already linked to a different ordering-app record in this campaign. The link changes only if no order of this campaign uses the old record.">
                                  linked to another record
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs">{row.b44.id}</TableCell>
                        </TableRow>
                      ))}
                      {preview.length === 0 && (
                        <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-6">
                          No products found for this group buy in the ordering app.
                        </TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer">Raw first record (for field mapping)</summary>
                  <pre className="mt-1 p-2 bg-muted rounded overflow-x-auto">{JSON.stringify(preview[0]?.b44 ?? null, null, 2)}</pre>
                </details>
                <div className="flex gap-2">
                  <Button size="sm" onClick={importRows} disabled={busy || !preview.some(r => r.include)}>
                    {busy ? 'Importing…' : `Import ${preview.filter(r => r.include).length} products`}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPreview(null)} disabled={busy}>Cancel</Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Imports go to the shared catalog, and each ordering-app ID is linked for {groupBuy?.name} only —
                  the ordering app keeps a separate product record per group buy, so syncing this campaign never
                  changes another campaign's links. New products use their name as the SKU (that's how the export
                  writes items). Campaign cost/margin/MOQ still get set in “Add / update campaign product” — price
                  here is the customer-facing GB price, not vendor cost.
                </p>
              </>
            )}
            {error && <p className="text-sm text-rose-400">{error}</p>}
            {doneMsg && <p className="text-sm text-emerald-300">{doneMsg}</p>}
            {linkProblems.length > 0 && (
              <div className="rounded border border-amber-400/40 bg-amber-400/5 p-2 text-sm text-amber-200 space-y-1">
                <p className="font-semibold">{linkProblems.length} link(s) not changed:</p>
                {linkProblems.map(m => <p key={m} className="text-xs break-words">{m}</p>)}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
