import React, { useMemo, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import saveProduct from '@/actions/products/saveProduct';
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

type ExistingProduct = { id: number; external_id: string | null; sku_code: string; name: string };

type PreviewRow = {
  include: boolean;
  b44: B44Product;
  match: ExistingProduct | null;
};

export function OrderingAppSync({ products, onImported }: {
  products: ExistingProduct[];
  onImported: () => void;
}) {
  const { groupBuy, settings, reloadGroupBuys } = useApp();
  const [doSaveProduct] = useMutateAction(saveProduct);
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
  const [unscoped, setUnscoped] = useState(false);
  const [doneMsg, setDoneMsg] = useState('');

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
      await doLinkGb({ id: groupBuy.id, external_id: pickedB44Id });
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
    setBusy(true); setError(''); setDoneMsg('');
    try {
      const all = await listB44Products(cfg);
      const scoped = scopeProductsToGroupBuy(all, groupBuy.external_id);
      setUnscoped(scoped === null);
      const list = scoped ?? all;
      setPreview(list.map(p => {
        const name = String(p.name ?? '').trim();
        const match =
          products.find(x => x.external_id === p.id) ||
          products.find(x => x.sku_code.toLowerCase() === name.toLowerCase() || x.name.toLowerCase() === name.toLowerCase()) ||
          null;
        return { include: !!name, b44: p, match };
      }));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to pull products');
    } finally {
      setBusy(false);
    }
  };

  const importRows = async () => {
    if (!preview) return;
    setBusy(true); setError(''); setDoneMsg('');
    let created = 0, updated = 0;
    try {
      for (const row of preview) {
        if (!row.include) continue;
        const name = String(row.b44.name ?? '').trim();
        if (!name) continue;
        await doSaveProduct({
          // SKU must match how the ordering app writes items in exports, which
          // is the product name — existing rows keep their curated SKU because
          // the upsert conflicts on sku_code via the matched product.
          sku_code: row.match ? row.match.sku_code : name,
          name,
          mass_label: '',
          external_id: row.b44.id,
          active: true,
        });
        if (row.match) updated++; else created++;
      }
      setDoneMsg(`Imported: ${created} new, ${updated} updated.`);
      setPreview(null);
      onImported();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Import failed part-way — re-running is safe (upserts).');
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
          {error && <p className="text-sm text-red-600">{error}</p>}
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
                  <p className="text-sm text-amber-600">
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
                            {row.match
                              ? <Badge variant="secondary">update “{row.match.sku_code}”</Badge>
                              : <Badge>create</Badge>}
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
                  Imports go to the shared catalog with the ordering-app ID attached; new products use their
                  name as the SKU (that's how the export writes items). Campaign cost/margin/MOQ still get set
                  in “Add / update campaign product” — price here is the customer-facing GB price, not vendor cost.
                </p>
              </>
            )}
            {error && <p className="text-sm text-red-600">{error}</p>}
            {doneMsg && <p className="text-sm text-green-700">{doneMsg}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
