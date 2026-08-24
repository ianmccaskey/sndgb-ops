import React, { useRef, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import saveReceiveAddress from '@/actions/receiving/saveReceiveAddress';
import createInboundPackage from '@/actions/receiving/createInboundPackage';
import commitInboundPackage from '@/actions/receiving/commitInboundPackage';
import { parseCsv, headerIndex } from '@/lib/csv';
import { useApp } from '@/app/AppContext';
import { fmtNum } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { productChipClass } from './shared';
import type { RxAddress, CatalogProduct, VendorRow } from './shared';

/*
 * CSV importers for Receiving. Two independent flows, both PARSE-FIRST:
 * nothing writes until the operator has seen a per-row/per-package
 * preview with every validation verdict, then explicitly imports the
 * valid entries. All writes go through the existing audited actions
 * (saveReceiveAddress upserts by label; createInboundPackage is atomic
 * with its item lines and enforces vendor eligibility server-side), so
 * the importers add zero new trust surface.
 */

const KNOWN_CARRIERS = ['usps', 'ups', 'fedex', 'dhl_express', 'dhl_ecommerce', 'canada_post', 'shippo'];

// ---------- address import types ----------
type AddrRow = {
  line: number; label: string; name: string; street1: string; street2: string;
  city: string; state: string; zip: string; country: string; phone: string; email: string;
  ok: boolean; reason: string;
  // a later CSV row targets the same label (case-sensitive, the upsert
  // key) — this row is never written, so "last one wins" holds even
  // under mid-run failures or retries
  shadowed: boolean;
};

// ---------- package import types ----------
type PkgLine = { line: number; productId: number; sku: string; qtyCents: number };
type PkgGroup = {
  key: string; carrier: string; tracking: string; addressId: number | null; addressLabel: string;
  vendorId: number | null; vendorCode: string; note: string;
  items: PkgLine[];
  ok: boolean; reasons: string[]; warnings: string[];
};

function qtyToCents(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(t) || !(Number(t) > 0)) return null;
  const [w, f = ''] = t.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
}

export function ImportTab({ addresses, vendors, products, reloadAddresses, afterPackageChange }: {
  addresses: RxAddress[]; vendors: VendorRow[]; products: CatalogProduct[];
  reloadAddresses: () => void; afterPackageChange: () => void;
}) {
  const { userName, groupBuyId } = useApp();
  const [doSaveAddress] = useMutateAction(saveReceiveAddress);
  const [doCreatePkg] = useMutateAction(createInboundPackage);
  const [doCommitPkg] = useMutateAction(commitInboundPackage);

  // ---------- addresses ----------
  const [aText, setAText] = useState('');
  const [aRows, setARows] = useState<AddrRow[] | null>(null);
  const [aResults, setAResults] = useState<string[]>([]);
  const [aBusy, setABusy] = useState(false);
  const [aErr, setAErr] = useState('');
  const aFile = useRef<HTMLInputElement>(null);

  // ---------- packages ----------
  const [pText, setPText] = useState('');
  const [pGroups, setPGroups] = useState<PkgGroup[] | null>(null);
  const [pRowErrors, setPRowErrors] = useState<string[]>([]);
  const [pResults, setPResults] = useState<string[]>([]);
  const [pBusy, setPBusy] = useState(false);
  const [pErr, setPErr] = useState('');
  const pFile = useRef<HTMLInputElement>(null);

  const loadFile = (input: HTMLInputElement | null, set: (t: string) => void) => {
    const f = input?.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => set(String(r.result || ''));
    r.readAsText(f);
    if (input) input.value = '';
  };

  // ================= ADDRESS PARSE =================
  const parseAddresses = () => {
    setAErr(''); setARows(null); setAResults([]);
    const { rows, error } = parseCsv(aText);
    if (error) { setAErr(`CSV error — ${error}`); return; }
    if (rows.length < 2) { setAErr('Need a header row plus at least one data row.'); return; }
    const h = rows[0];
    const col = {
      label: headerIndex(h, ['label']),
      name: headerIndex(h, ['name', 'recipient', 'recipientname']),
      street1: headerIndex(h, ['street1', 'street', 'address1', 'address']),
      street2: headerIndex(h, ['street2', 'address2', 'apt', 'unit', 'aptunit']),
      city: headerIndex(h, ['city']),
      state: headerIndex(h, ['state', 'province']),
      zip: headerIndex(h, ['zip', 'zipcode', 'postal', 'postalcode']),
      country: headerIndex(h, ['country']),
      phone: headerIndex(h, ['phone', 'phonenumber']),
      email: headerIndex(h, ['email']),
    };
    const missing = (['label', 'name', 'street1', 'city', 'state', 'zip'] as const).filter(k => col[k] < 0);
    if (missing.length) { setAErr(`Missing required column(s): ${missing.join(', ')}. Expected headers like: label,name,street1,street2,city,state,zip,phone,email.`); return; }
    const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : '');
    const out: AddrRow[] = rows.slice(1).map((r, idx) => {
      const row: AddrRow = {
        line: idx + 2,
        label: get(r, col.label), name: get(r, col.name), street1: get(r, col.street1),
        street2: get(r, col.street2), city: get(r, col.city), state: get(r, col.state),
        zip: get(r, col.zip), country: get(r, col.country) || 'US',
        phone: get(r, col.phone), email: get(r, col.email),
        ok: true, reason: '', shadowed: false,
      };
      const req = (['label', 'name', 'street1', 'city', 'state', 'zip'] as const).filter(k => !row[k]);
      if (req.length) { row.ok = false; row.reason = `missing ${req.join(', ')}`; }
      return row;
    });
    // the upsert key is the CASE-SENSITIVE label: dedupe in-CSV duplicates
    // to the FINAL occurrence (earlier ones are shadowed and never
    // written), flag exact-label updates, and warn on case-only
    // collisions — 'home' next to an existing 'Home' CREATES A SEPARATE
    // ADDRESS, which is almost never intended
    const lastByLabel = new Map<string, number>();
    out.forEach((row, i) => { if (row.ok) lastByLabel.set(row.label, i); });
    out.forEach((row, i) => {
      if (!row.ok) return;
      if (lastByLabel.get(row.label) !== i) {
        row.shadowed = true;
        row.reason = `superseded by line ${out[lastByLabel.get(row.label)!].line} (same label — last one wins; this row is not written)`;
        return;
      }
      if (addresses.some(a => a.label === row.label)) row.reason = 'updates an existing address';
      else {
        const ciClash = addresses.find(a => a.label.toLowerCase() === row.label.toLowerCase());
        if (ciClash) row.reason = `WARNING: differs only by case from existing "${ciClash.label}" — this creates a SEPARATE address`;
      }
    });
    setARows(out);
  };

  const importAddresses = async () => {
    if (!aRows) return;
    setABusy(true); setAResults([]);
    const results: string[] = [];
    for (const row of aRows) {
      if (!row.ok || row.shadowed) { results.push(`line ${row.line} (${row.label || '?'}): skipped — ${row.reason}`); continue; }
      try {
        const res = await doSaveAddress({
          label: row.label, name: row.name, street1: row.street1, street2: row.street2,
          city: row.city, state: row.state, zip: row.zip, country: row.country,
          phone: row.phone, email: row.email, actor: userName,
        }) as unknown[] | null;
        results.push(Array.isArray(res) && res.length > 0
          ? `line ${row.line} (${row.label}): saved`
          : `line ${row.line} (${row.label}): REFUSED — check required fields`);
      } catch (e: unknown) {
        results.push(`line ${row.line} (${row.label}): FAILED — ${e instanceof Error ? e.message : 'error'}`);
      }
    }
    setAResults(results); setABusy(false); setARows(null); reloadAddresses();
  };

  // ================= PACKAGE PARSE =================
  const parsePackages = () => {
    setPErr(''); setPGroups(null); setPRowErrors([]); setPResults([]);
    const { rows, error } = parseCsv(pText);
    if (error) { setPErr(`CSV error — ${error}`); return; }
    if (rows.length < 2) { setPErr('Need a header row plus at least one data row.'); return; }
    const h = rows[0];
    const col = {
      address: headerIndex(h, ['address', 'addresslabel', 'to', 'toaddress', 'receiveaddress']),
      vendor: headerIndex(h, ['vendor', 'vendorcode']),
      product: headerIndex(h, ['product', 'sku', 'skucode', 'productsku']),
      count: headerIndex(h, ['count', 'qty', 'quantity', 'productcount']),
      carrier: headerIndex(h, ['carrier']),
      tracking: headerIndex(h, ['tracking', 'trackingnumber', 'trackingno', 'tracking#']),
      note: headerIndex(h, ['note', 'notes']),
    };
    const missing = (['address', 'product', 'count', 'carrier', 'tracking'] as const).filter(k => col[k] < 0);
    if (missing.length) { setPErr(`Missing required column(s): ${missing.join(', ')}. Expected headers like: address,vendor,product,count,carrier,tracking,note.`); return; }
    const get = (r: string[], i: number) => (i >= 0 && i < r.length ? r[i].trim() : '');

    const rowErrors: string[] = [];
    const groups = new Map<string, PkgGroup>();
    for (let idx = 0; idx < rows.length - 1; idx++) {
      const r = rows[idx + 1];
      const line = idx + 2;
      const addrLabel = get(r, col.address);
      const vendorCode = get(r, col.vendor);
      const sku = get(r, col.product);
      const qtyRaw = get(r, col.count);
      const carrier = get(r, col.carrier).toLowerCase().replace(/\s+/g, '_');
      const tracking = get(r, col.tracking).toUpperCase();
      const note = get(r, col.note);

      if (!tracking || !carrier) { rowErrors.push(`line ${line}: missing carrier or tracking — row skipped`); continue; }
      // labels are unique CASE-SENSITIVELY, so 'Home' and 'home' can both
      // exist: prefer the exact-case match; a case-insensitive match is
      // accepted only when it is UNAMBIGUOUS — multiple candidates refuse
      // rather than guess (mis-routed inventory is expensive to unwind)
      const ciMatches = addresses.filter(a => a.active && a.label.toLowerCase() === addrLabel.toLowerCase());
      const exact = ciMatches.find(a => a.label === addrLabel);
      const addr = exact || (ciMatches.length === 1 ? ciMatches[0] : undefined);
      const addrAmbiguous = !exact && ciMatches.length > 1;
      const vendor = vendorCode ? vendors.find(v => v.shippable && v.code.toLowerCase() === vendorCode.toLowerCase()) : null;
      const product = products.find(p => p.sku_code.toLowerCase() === sku.toLowerCase())
        || products.find(p => p.name.toLowerCase() === sku.toLowerCase());
      const qtyCents = qtyToCents(qtyRaw);

      const key = `${carrier}|${tracking}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key, carrier, tracking, addressId: addr ? Number(addr.id) : null, addressLabel: addrLabel,
          vendorId: vendor ? Number(vendor.id) : null, vendorCode, note,
          items: [], ok: true, reasons: [], warnings: [],
        };
        if (!addrLabel) g.reasons.push('missing address');
        else if (addrAmbiguous) g.reasons.push(`address "${addrLabel}" is AMBIGUOUS — multiple active labels differ only by case (${ciMatches.map(a => `"${a.label}"`).join(', ')}); use the exact label`);
        else if (!addr) g.reasons.push(`address "${addrLabel}" not found among ACTIVE receive addresses`);
        if (vendorCode && !vendor) g.reasons.push(`vendor "${vendorCode}" is not a shipping vendor for this buy`);
        if (!KNOWN_CARRIERS.includes(carrier)) g.warnings.push(`carrier "${carrier}" is not a known Shippo token — it will be sent as-is`);
        groups.set(key, g);
      } else {
        if (addrLabel.toLowerCase() !== g.addressLabel.toLowerCase()) g.reasons.push(`line ${line}: same tracking with a DIFFERENT address ("${addrLabel}" vs "${g.addressLabel}")`);
        if (vendorCode.toLowerCase() !== g.vendorCode.toLowerCase()) g.reasons.push(`line ${line}: same tracking with a DIFFERENT vendor ("${vendorCode}" vs "${g.vendorCode}")`);
        if (!g.note && note) g.note = note;
      }
      if (!sku) g.reasons.push(`line ${line}: missing product`);
      else if (!product) g.reasons.push(`line ${line}: product "${sku}" not found in the catalog (match by SKU or exact name)`);
      if (qtyCents === null) g.reasons.push(`line ${line}: count "${qtyRaw}" must be a positive number with at most 2 decimals`);
      if (product && qtyCents !== null) {
        const existing = g.items.find(it => it.productId === Number(product.id));
        if (existing) { existing.qtyCents += qtyCents; g.warnings.push(`line ${line}: duplicate product ${product.sku_code} merged (quantities summed)`); }
        else g.items.push({ line, productId: Number(product.id), sku: product.sku_code, qtyCents });
      }
    }
    for (const g of groups.values()) {
      if (g.items.length === 0) g.reasons.push('no valid product lines');
      if (g.reasons.length > 0) g.ok = false;
    }
    setPRowErrors(rowErrors);
    setPGroups(Array.from(groups.values()));
  };

  const importPackages = async () => {
    if (!pGroups) return;
    setPBusy(true); setPResults([]);
    const results: string[] = [];
    for (const g of pGroups) {
      const tag = `${g.carrier.toUpperCase()} ${g.tracking}`;
      if (!g.ok) { results.push(`${tag}: skipped — ${g.reasons[0]}`); continue; }
      try {
        const res = await doCreatePkg({
          receive_address_id: g.addressId, vendor_id: g.vendorId != null ? String(g.vendorId) : '',
          group_buy_id: groupBuyId ?? '',
          carrier: g.carrier, tracking_number: g.tracking, note: g.note,
          items: JSON.stringify(g.items.map(it => ({ product_id: it.productId, qty: (it.qtyCents / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1') }))),
          actor: userName,
        }) as unknown[] | null;
        const pkgId = Array.isArray(res) && res.length > 0 ? Number((res[0] as { id: string }).id) : null;
        if (!pkgId) { results.push(`${tag}: REFUSED — nothing saved (address active? vendor eligible? counts valid?)`); continue; }
        const com = await doCommitPkg({ package_id: pkgId, actor: userName }) as unknown[] | null;
        results.push(Array.isArray(com) && com.length > 0
          ? `${tag}: created + committed (${g.items.length} line${g.items.length === 1 ? '' : 's'})`
          : `${tag}: created as DRAFT — commit failed, use the card's Commit button`);
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : '';
        results.push(m.includes('inbound_packages_active_tracking_uniq')
          ? `${tag}: skipped — an ACTIVE package with this tracking already exists`
          : `${tag}: FAILED — ${m || 'error'}`);
      }
    }
    setPResults(results); setPBusy(false); setPGroups(null); afterPackageChange();
  };

  const validAddrCount = aRows?.filter(r => r.ok && !r.shadowed).length ?? 0;
  const validPkgCount = pGroups?.filter(g => g.ok).length ?? 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Import receive addresses (CSV)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Headers: <span className="font-mono">label,name,street1,street2,city,state,zip,phone,email</span> — label/name/street1/city/state/zip required. An existing label is UPDATED. Nothing writes until you review the preview and click Import.
          </p>
          <textarea
            className="w-full border rounded-md p-2 font-mono text-xs min-h-28"
            placeholder={'label,name,street1,street2,city,state,zip,phone,email\nIan Home,Ian M,123 Main St,,Dallas,TX,75001,,'}
            value={aText} onChange={e => { setAText(e.target.value); setARows(null); }}
          />
          <div className="flex flex-wrap gap-2 items-center">
            <input ref={aFile} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={() => loadFile(aFile.current, t => { setAText(t); setARows(null); })} />
            <Button size="sm" variant="outline" onClick={() => aFile.current?.click()}>Load CSV file…</Button>
            <Button size="sm" variant="outline" disabled={!aText.trim()} onClick={parseAddresses}>Parse & preview</Button>
            {aRows && <Button size="sm" disabled={aBusy || validAddrCount === 0} onClick={importAddresses}>{aBusy ? 'Importing…' : `Import ${validAddrCount} address${validAddrCount === 1 ? '' : 'es'}`}</Button>}
          </div>
          {aErr && <p className="text-xs text-red-600">{aErr}</p>}
          {aRows && (
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Line</TableHead><TableHead>Label</TableHead><TableHead>Address</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {aRows.map(r => (
                    <TableRow key={r.line}>
                      <TableCell className="text-xs">{r.line}</TableCell>
                      <TableCell className="text-xs font-medium whitespace-nowrap">{r.label || '—'}</TableCell>
                      <TableCell className="text-xs">{[r.name, r.street1, r.street2, r.city, r.state, r.zip].filter(Boolean).join(', ')}</TableCell>
                      <TableCell className={`text-xs ${r.ok ? (r.reason ? 'text-amber-700' : 'text-green-700') : 'text-red-600'}`}>{r.ok ? (r.reason || 'new') : `invalid — ${r.reason}`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {aResults.length > 0 && (
            <div className="text-xs space-y-0.5">
              {aResults.map((m, i) => <p key={i} className={m.includes('saved') ? 'text-green-700' : 'text-red-600'}>{m}</p>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Import packages / tracking (CSV)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Headers: <span className="font-mono">address,vendor,product,count,carrier,tracking,note</span> — vendor and note optional. Rows sharing a tracking number become ONE package with multiple product lines. Address matches your ACTIVE receive-address labels; product matches catalog SKU (or exact name); carrier is a Shippo token (usps, ups, fedex…). Imported packages are committed immediately (tracking starts on the next refresh).
          </p>
          <textarea
            className="w-full border rounded-md p-2 font-mono text-xs min-h-28"
            placeholder={'address,vendor,product,count,carrier,tracking\nIan Home,HXTNT,R10,28,ups,1Z999AA10123456784'}
            value={pText} onChange={e => { setPText(e.target.value); setPGroups(null); }}
          />
          <div className="flex flex-wrap gap-2 items-center">
            <input ref={pFile} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={() => loadFile(pFile.current, t => { setPText(t); setPGroups(null); })} />
            <Button size="sm" variant="outline" onClick={() => pFile.current?.click()}>Load CSV file…</Button>
            <Button size="sm" variant="outline" disabled={!pText.trim()} onClick={parsePackages}>Parse & preview</Button>
            {pGroups && <Button size="sm" disabled={pBusy || validPkgCount === 0} onClick={importPackages}>{pBusy ? 'Importing…' : `Import ${validPkgCount} package${validPkgCount === 1 ? '' : 's'}`}</Button>}
          </div>
          {pErr && <p className="text-xs text-red-600">{pErr}</p>}
          {pRowErrors.length > 0 && (
            <div className="text-xs space-y-0.5">{pRowErrors.map((m, i) => <p key={i} className="text-red-600">{m}</p>)}</div>
          )}
          {pGroups && (
            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Tracking</TableHead><TableHead>Address</TableHead><TableHead>Vendor</TableHead><TableHead>Contents</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
                <TableBody>
                  {pGroups.map(g => (
                    <TableRow key={g.key}>
                      <TableCell className="text-xs font-mono whitespace-nowrap">{g.carrier.toUpperCase()} · {g.tracking}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{g.addressLabel || '—'}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{g.vendorCode || '—'}</TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1 max-w-64">
                          {g.items.map(it => (
                            <span key={it.productId} className={`rounded text-[10px] font-semibold px-1.5 py-0.5 whitespace-nowrap ${productChipClass(it.productId)}`}>{it.sku} × {fmtNum(it.qtyCents / 100)}</span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className={`text-xs ${g.ok ? (g.warnings.length ? 'text-amber-700' : 'text-green-700') : 'text-red-600'}`}>
                        {g.ok ? (g.warnings[0] || 'ready') : g.reasons[0]}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {pResults.length > 0 && (
            <div className="text-xs space-y-0.5">
              {pResults.map((m, i) => <p key={i} className={m.includes('created') ? 'text-green-700' : 'text-red-600'}>{m}</p>)}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
