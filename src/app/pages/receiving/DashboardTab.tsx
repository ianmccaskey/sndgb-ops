import React, { useRef, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import createInboundPackage from '@/actions/receiving/createInboundPackage';
import addPackageItem from '@/actions/receiving/addPackageItem';
import deletePackageItem from '@/actions/receiving/deletePackageItem';
import commitInboundPackage from '@/actions/receiving/commitInboundPackage';
import updatePackageCarrierTracking from '@/actions/receiving/updatePackageCarrierTracking';
import markPackageReceived from '@/actions/receiving/markPackageReceived';
import unmarkPackageReceived from '@/actions/receiving/unmarkPackageReceived';
import deleteInboundPackage from '@/actions/receiving/deleteInboundPackage';
import { useApp } from '@/app/AppContext';
import { fmtDate, fmtDateTime, fmtNum } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RefreshCw, Truck, AlertTriangle, ScanLine } from 'lucide-react';
import { decodeCarrierLabel, trackingCandidates, matchTracking, candidateCarrier, carrierCompatible } from '@/lib/labelScan';
import { productChipClass, trackLabel, trackClass, isOutForDeliveryToday } from './shared';
import type { RxAddress, Pkg, CatalogProduct, VendorRow } from './shared';

const CARRIERS = [
  { token: 'usps', label: 'USPS' },
  { token: 'ups', label: 'UPS' },
  { token: 'fedex', label: 'FedEx' },
  { token: 'dhl_express', label: 'DHL Express' },
  { token: 'dhl_ecommerce', label: 'DHL eCommerce' },
  { token: 'canada_post', label: 'Canada Post' },
  { token: '__other__', label: 'Other (Shippo token)…' },
];

type ItemLine = { product: string; qty: string };

export function DashboardTab({ addresses, packages, products, vendors, vendorsReady, refreshOne, refreshAll, refreshingIds, refreshAllProgress, afterChange, hasKey, testMode }: {
  addresses: RxAddress[]; packages: Pkg[]; products: CatalogProduct[]; vendors: VendorRow[]; vendorsReady: boolean;
  refreshOne: (p: Pkg) => Promise<string | null>;
  refreshAll: () => Promise<void>;
  refreshingIds: Set<number>;
  refreshAllProgress: string;
  afterChange: () => void;
  hasKey: boolean;
  testMode: boolean;
}) {
  const { userName, groupBuyId } = useApp();
  const [doCreate] = useMutateAction(createInboundPackage);
  const [doAddItem] = useMutateAction(addPackageItem);
  const [doDelItem] = useMutateAction(deletePackageItem);
  const [doCommit] = useMutateAction(commitInboundPackage);
  const [doCorrect] = useMutateAction(updatePackageCarrierTracking);
  const [doReceive] = useMutateAction(markPackageReceived);
  const [doUnreceive] = useMutateAction(unmarkPackageReceived);
  const [doDelete] = useMutateAction(deleteInboundPackage);

  // ---- create form ----
  const [fAddr, setFAddr] = useState('');
  const [fVendor, setFVendor] = useState('');
  const [fCarrier, setFCarrier] = useState('usps');
  const [fCarrierOther, setFCarrierOther] = useState('');
  const [fTracking, setFTracking] = useState('');
  const [fNote, setFNote] = useState('');
  const [fLines, setFLines] = useState<ItemLine[]>([{ product: '', qty: '' }]);
  const [fMsg, setFMsg] = useState('');
  const [fSaving, setFSaving] = useState(false);

  // ---- filters ----
  const [productFilter, setProductFilter] = useState<Set<number>>(new Set());
  const [addrFilter, setAddrFilter] = useState('all');
  // default view is EVERYTHING — all addresses, all packages, all vendors
  // (operator preference; narrowing is one click away)
  const [statusFilter, setStatusFilter] = useState('all');
  const [vendorFilter, setVendorFilter] = useState('all');

  // ---- correction dialog ----
  const [correcting, setCorrecting] = useState<Pkg | null>(null);
  const [cCarrier, setCCarrier] = useState('');
  const [cTracking, setCTracking] = useState('');
  const [cMsg, setCMsg] = useState('');
  const [rowMsg, setRowMsg] = useState<Record<number, string>>({});
  // per-draft add-item row: { productId, qty }
  const [rowItem, setRowItem] = useState<Record<number, { product: string; qty: string }>>({});

  const addItemToCard = async (p: Pkg) => {
    const line = rowItem[p.id];
    if (!line?.product || !/^\d+(?:\.\d{1,2})?$/.test((line?.qty || '').trim()) || !(Number(line?.qty) > 0)) {
      setRowMsg(m => ({ ...m, [p.id]: 'Pick a product and a positive count.' })); return;
    }
    const res = await doAddItem({ package_id: p.id, product_id: Number(line.product), qty: line.qty.trim(), actor: userName }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) setRowMsg(m => ({ ...m, [p.id]: 'Not added — received packages are locked.' }));
    else { setRowMsg(m => ({ ...m, [p.id]: '' })); setRowItem(m => ({ ...m, [p.id]: { product: '', qty: '' } })); }
    afterChange();
  };

  const removeItemFromCard = async (p: Pkg, itemId: number) => {
    const res = await doDelItem({ item_id: itemId, actor: userName }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) setRowMsg(m => ({ ...m, [p.id]: 'Not removed — received packages are locked, and a committed package must keep at least one line (delete the whole package instead).' }));
    afterChange();
  };

  const carrierToken = fCarrier === '__other__' ? fCarrierOther.trim().toLowerCase() : fCarrier;

  // a vendor picked before a campaign switch may no longer be shippable in
  // the newly selected buy — clear the stale selection instead of letting
  // a hidden value bypass the picker's restriction. vendorsReady says the
  // list RESOLVED CLEANLY for the current campaign (an in-flight or failed
  // reload collapses to [] and must not wipe valid state), and a resolved
  // list is authoritative even when empty — the submit-time and SQL guards
  // still cover the never-resolves case.
  React.useEffect(() => {
    if (vendorsReady && fVendor && !vendors.some(v => v.shippable && String(v.id) === fVendor)) setFVendor('');
  }, [vendorsReady, vendors, fVendor]);
  // the dashboard vendor FILTER gets the same treatment: a code that left
  // the option set after a campaign switch must not keep silently
  // filtering the page down to nothing
  React.useEffect(() => {
    if (vendorsReady && vendorFilter !== 'all' && !vendors.some(v => v.code === vendorFilter)) setVendorFilter('all');
  }, [vendorsReady, vendors, vendorFilter]);

  const createPackage = async () => {
    setFMsg('');
    const lines = fLines.filter(l => l.product || l.qty.trim());
    if (!fAddr) { setFMsg('Pick a receive address.'); return; }
    // belt for the race the effect can't win: never submit a vendor that
    // isn't shippable in the currently selected campaign
    if (fVendor && !vendors.some(v => v.shippable && String(v.id) === fVendor)) {
      setFMsg('The selected vendor is not available in this campaign — re-pick it or use "No vendor".');
      return;
    }
    if (!carrierToken) { setFMsg('Pick a carrier (or enter its Shippo token).'); return; }
    if (!fTracking.trim()) { setFMsg('Tracking number required.'); return; }
    if (lines.length === 0) { setFMsg('Add at least one product line — the contents feed inventory.'); return; }
    for (const l of lines) {
      if (!l.product) { setFMsg('Every line needs a product.'); return; }
      if (!/^\d+(?:\.\d{1,2})?$/.test(l.qty.trim()) || !(Number(l.qty) > 0)) { setFMsg('Every line needs a positive count (max 2 decimals).'); return; }
    }
    if (new Set(lines.map(l => l.product)).size !== lines.length) {
      setFMsg('The same product appears on two lines — combine them into one line.'); return;
    }
    setFSaving(true);
    try {
      // ATOMIC: package + every content line in ONE statement — either the
      // whole package saves or nothing does, so a transient failure can
      // never leave a partial package that later commits with missing
      // contents and understates inventory
      let res: unknown[] | null;
      try {
        res = await doCreate({
          // no label expectation: the operator picked this address by id
          // from the live list moments ago
          expected_label: '',
          receive_address_id: Number(fAddr), vendor_id: fVendor || '',
          // the action re-checks vendor eligibility against THIS campaign
          group_buy_id: groupBuyId ?? '',
          carrier: carrierToken, tracking_number: fTracking.trim(), note: fNote.trim(),
          items: JSON.stringify(lines.map(l => ({ product_id: Number(l.product), qty: l.qty.trim() }))),
          actor: userName,
        }) as unknown[] | null;
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : '';
        setFMsg(m.includes('inbound_packages_active_tracking_uniq')
          ? 'An ACTIVE package with this carrier + tracking number already exists.'
          : (m || 'Failed to create the package.') + ' Nothing was saved — the form is unchanged, retry.');
        return;
      }
      const pkgId = Array.isArray(res) && res.length > 0 ? Number((res[0] as { id: string }).id) : null;
      if (!pkgId) { setFMsg('Not created — nothing was saved. Check the address is active, carrier/tracking are filled, every line has a positive count, and the vendor ships product in this campaign.'); return; }
      setFMsg('');
      setFTracking(''); setFNote(''); setFLines([{ product: '', qty: '' }]);
      afterChange();
    } finally {
      setFSaving(false);
    }
  };

  const commitPkg = async (p: Pkg) => {
    const res = await doCommit({ package_id: p.id, actor: userName }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
      setRowMsg(m => ({ ...m, [p.id]: 'Not committed — it needs at least one product line.' }));
      return;
    }
    setRowMsg(m => ({ ...m, [p.id]: '' }));
    afterChange();
    // first tracking check right away, so the card shows something — and if
    // it refuses (mangled tracking, Shippo problem), say so on the row now
    // rather than letting commit look like tracking started
    if (hasKey) {
      const err = await refreshOne({ ...p, committed_at: new Date().toISOString() });
      if (err) setRowMsg(m => ({ ...m, [p.id]: err }));
      afterChange();
    }
  };

  // ---- scan-to-receive: photograph the carrier label, decode its
  // tracking barcode client-side, match against LOGGED packages, and
  // receive on confirmation. The scan never creates or mutates anything
  // by itself — it only routes to the existing audited receive. ----
  const [scanBusy, setScanBusy] = useState(false);
  const [scanMsg, setScanMsg] = useState('');
  const scanInputRef = useRef<HTMLInputElement | null>(null);
  const onScanPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setScanBusy(true); setScanMsg('');
    try {
      const texts = await decodeCarrierLabel(files[0]);
      if (texts.length === 0) {
        setScanMsg('No barcode found in the photo — get closer, keep the label flat, and avoid glare.');
        return;
      }
      const candidates = texts.flatMap(trackingCandidates);
      if (candidates.length === 0) {
        setScanMsg(`A barcode was read (${texts[0]}) but it does not look like a tracking number.`);
        return;
      }
      // match against every logged package (mangled rows can never pass
      // the receive CAS, so they are excluded up front), GRADED: only an
      // EXACT fingerprint match may auto-receive; suffix relations are
      // surfaced for the operator to act on from the card
      const matchedAll = packages
        .filter(p => !p.tracking_mangled)
        .map(p => ({ p, kind: matchTracking(candidates, String(p.tracking_number || '')) }))
        .filter((x): x is { p: Pkg; kind: 'exact' | 'suffix' } => x.kind != null);
      // the system's identity is carrier + tracking, and the same number
      // may legitimately exist on different carriers — a scan that
      // matches across carriers is AMBIGUOUS, never auto-received
      if (new Set(matchedAll.map(x => x.p.carrier)).size > 1) {
        setScanMsg(`The scan matches packages on different carriers (${matchedAll.map(x => `${(x.p.carrier || '').toUpperCase()} ${x.p.tracking_number}`).join('; ')}) — check the label's carrier and receive from the right card.`);
        return;
      }
      const open = matchedAll.filter(x => !x.p.received_at && x.p.committed_at);
      const openExact = open.filter(x => x.kind === 'exact');
      if (openExact.length === 1) {
        const p = openExact[0].p;
        // the EXACT-matching candidate's structural carrier (1Z = UPS;
        // IMpb shape = USPS/DHL eCommerce) must not contradict the
        // package's logged carrier
        const t = String(p.tracking_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const exactCand = candidates.find(c => c === t);
        if (exactCand && !carrierCompatible(candidateCarrier(exactCand), p.carrier)) {
          setScanMsg(`The barcode's format does not match the package's logged carrier (${(p.carrier || '').toUpperCase()}) — check the label and the package, then receive from its card.`);
          return;
        }
        const contents = (p.items || []).map(i => `${i.sku_code}×${fmtNum(i.qty)}`).join(', ') || 'no items';
        if (window.confirm(`Receive ${p.tracking_number}\nCarrier: ${(p.carrier || '').toUpperCase()}${p.vendor_code ? ` · Vendor: ${p.vendor_code}` : ''}\nAddress: ${p.address_label}\nContents: ${contents}\n\nOK marks it received.`)) {
          const ok = await receivePkg(p);
          setScanMsg(ok
            ? `Received ${p.tracking_number}.`
            : 'NOT received — the package changed since this page loaded (already received, corrected, or emptied elsewhere). Check its card; the list has refreshed.');
        }
      } else if (openExact.length > 1) {
        setScanMsg(`The scan matches ${openExact.length} open packages (${openExact.map(x => x.p.tracking_number).join(', ')}) — receive the right one from its card.`);
      } else if (open.length > 0) {
        // suffix relations only: never auto-received — the number on the
        // label must be verified by eye against the card
        setScanMsg(`The scan LIKELY corresponds to ${open.map(x => `${x.p.tracking_number} (${(x.p.carrier || '').toUpperCase()})`).join(', ')} but is not an exact match — verify the label's number and receive from the card.`);
      } else if (matchedAll.some(x => x.p.received_at)) {
        const r = matchedAll.find(x => x.p.received_at)!.p;
        setScanMsg(`${r.tracking_number} is already received (${fmtDateTime(r.received_at!)} by ${r.received_by}).`);
      } else if (matchedAll.some(x => !x.p.committed_at)) {
        setScanMsg(`${matchedAll.find(x => !x.p.committed_at)!.p.tracking_number} is still a DRAFT — commit it on its card, then scan again.`);
      } else {
        setScanMsg(`Scanned ${candidates[0]} — no logged package matches. Log the package first, then scan to receive it.`);
      }
    } catch (e: unknown) {
      setScanMsg(e instanceof Error ? e.message : 'Scan failed — try another photo.');
    } finally {
      setScanBusy(false);
      if (scanInputRef.current) scanInputRef.current.value = '';
    }
  };

  // returns whether the DB write actually happened — callers (the card
  // button ignores it; the scan flow reports honestly from it) must not
  // claim success on a zero-row refusal
  const receivePkg = async (p: Pkg): Promise<boolean> => {
    // the receive action CASes on carrier+tracking; a mangled row can never
    // supply the identity it needs — refuse with the real reason up front
    if (p.tracking_mangled) { setRowMsg(m => ({ ...m, [p.id]: 'Cannot mark received: the platform returned this tracking number rounded, so the identity check cannot pass. Delete the package and re-log it — the database record is intact.' })); return false; }
    const res = await doReceive({ package_id: p.id, carrier: p.carrier, tracking_number: p.tracking_number, actor: userName, mode: 'manual' }) as unknown[] | null;
    const ok = Array.isArray(res) ? res.length > 0 : !!res;
    if (!ok) setRowMsg(m => ({ ...m, [p.id]: 'Not received — is it committed, not already received, and unchanged since this page loaded? Reload and retry.' }));
    else setRowMsg(m => ({ ...m, [p.id]: '' }));
    afterChange();
    return ok;
  };

  const unreceivePkg = async (p: Pkg) => {
    if (!window.confirm(`Un-receive ${p.tracking_number}? Its contents leave ${p.address_label}'s inventory (on-hand may go negative if a transfer already went out).`)) return;
    try {
      const res = await doUnreceive({ package_id: p.id, actor: userName }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setRowMsg(m => ({ ...m, [p.id]: 'Not un-received.' }));
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : '';
      setRowMsg(m2 => ({ ...m2, [p.id]: m.includes('inbound_packages_active_tracking_uniq')
        ? 'Cannot un-receive: this tracking number is now in use by another active package.'
        : m || 'Failed.' }));
    }
    afterChange();
  };

  const deletePkg = async (p: Pkg) => {
    if (!window.confirm(`Delete package ${p.tracking_mangled ? '(unreadable tracking)' : p.tracking_number} (${p.address_label})? The full record is preserved in the audit log.`)) return;
    const res = await doDelete({ package_id: p.id, actor: userName }) as unknown[] | null;
    if (!(Array.isArray(res) ? res.length > 0 : !!res)) setRowMsg(m => ({ ...m, [p.id]: 'Not deleted — received packages must be un-received first.' }));
    afterChange();
  };

  const saveCorrection = async () => {
    if (!correcting) return;
    // the CAS below compares against the identity this dialog opened with;
    // a mangled row opened with a ROUNDED number, so the save could never
    // match — refuse with the real reason instead of the generic CAS copy
    if (correcting.tracking_mangled) { setCMsg('Cannot correct: the platform returned this tracking number rounded, so the original to match against is unrecoverable here. Delete the package and re-log it — the database record is intact.'); return; }
    setCMsg('');
    try {
      const res = await doCorrect({
        package_id: correcting.id, carrier: cCarrier.trim().toLowerCase(), tracking_number: cTracking.trim(),
        // the identity this dialog OPENED with — the action refuses a stale
        // save if another session corrected the package meanwhile
        expected_carrier: correcting.carrier, expected_tracking: correcting.tracking_number,
        actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) { setCMsg('Not saved — either it was received, a field is blank, or another session already corrected this package. Reload and retry.'); return; }
      setCorrecting(null);
      afterChange();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : '';
      setCMsg(m.includes('inbound_packages_active_tracking_uniq') ? 'An ACTIVE package with this carrier + tracking already exists.' : m || 'Failed.');
    }
  };

  // ---- filtering ----
  const pkgMatchesProduct = (p: Pkg) =>
    productFilter.size === 0 || (p.items || []).some(i => productFilter.has(Number(i.product_id)));
  const pkgMatchesStatus = (p: Pkg) => {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'incoming') return !p.received_at;
    if (statusFilter === 'received') return !!p.received_at;
    if (statusFilter === 'attention') return !p.received_at && (p.tracking_status === 'FAILURE' || p.tracking_status === 'RETURNED' || !!p.tracking_error);
    if (statusFilter === 'out_for_delivery') return isOutForDeliveryToday(p);
    return p.tracking_status === statusFilter && !p.received_at;
  };
  const visible = packages.filter(p =>
    pkgMatchesProduct(p) && pkgMatchesStatus(p)
    && (addrFilter === 'all' || String(p.receive_address_id) === addrFilter)
    && (vendorFilter === 'all' || p.vendor_code === vendorFilter));
  // the product filter scopes the ADDRESS CARDS to addresses that actually
  // have a matching package (per spec)
  const visibleAddressIds = new Set(visible.map(p => p.receive_address_id));
  const cardAddresses = addresses.filter(a => visibleAddressIds.has(a.id));

  const ofdToday = packages.filter(isOutForDeliveryToday);
  const ofdByAddress = new Map<string, number>();
  for (const p of ofdToday) ofdByAddress.set(p.address_label, (ofdByAddress.get(p.address_label) || 0) + 1);
  const lastChecked = packages.reduce<string | null>((latest, p) =>
    p.last_checked_at && (!latest || p.last_checked_at > latest) ? p.last_checked_at : latest, null);

  return (
    <div className="space-y-4">
      {/* heads-up: out for delivery TODAY, grouped by address */}
      {ofdToday.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 space-y-1">
          <div className="flex items-center gap-2 font-semibold">
            <Truck className="w-4 h-4 shrink-0" /> Out for delivery today
            <span className="text-[11px] font-normal">as of {fmtDateTime(lastChecked)}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {[...ofdByAddress.entries()].map(([label, n]) => (
              <span key={label} className="rounded bg-amber-100 px-2 py-0.5 font-medium">{label}: {n} package{n === 1 ? '' : 's'}</span>
            ))}
          </div>
        </div>
      )}

      {/* log an inbound package */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Log inbound package</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Select value={fAddr} onValueChange={setFAddr}>
              <SelectTrigger className="h-9 flex-1 min-w-36"><SelectValue placeholder="To address" /></SelectTrigger>
              <SelectContent>
                {addresses.filter(a => a.active).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={fVendor || 'none'} onValueChange={v => setFVendor(v === 'none' ? '' : v)}>
              <SelectTrigger className="h-9 w-32"><SelectValue placeholder="Vendor" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No vendor</SelectItem>
                {/* NEW packages: live shipping vendors only — historical-
                    only rows exist for the filter, never the picker */}
                {vendors.filter(v => v.shippable).map(v => <SelectItem key={v.id} value={String(v.id)}>{v.code}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={fCarrier} onValueChange={setFCarrier}>
              <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CARRIERS.map(c => <SelectItem key={c.token} value={c.token}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {fCarrier === '__other__' && (
              <Input placeholder="shippo carrier token" value={fCarrierOther} onChange={e => setFCarrierOther(e.target.value)} className="h-9 w-40 font-mono text-xs" />
            )}
            <Input placeholder="Tracking number" value={fTracking} onChange={e => setFTracking(e.target.value)} className="h-9 flex-1 min-w-44 font-mono text-xs" />
          </div>
          {fLines.map((l, i) => (
            <div key={i} className="flex flex-wrap gap-2 items-center">
              <Select value={l.product} onValueChange={v => setFLines(ls => ls.map((x, j) => j === i ? { ...x, product: v } : x))}>
                <SelectTrigger className="h-9 flex-1 min-w-44"><SelectValue placeholder="Product" /></SelectTrigger>
                <SelectContent>
                  {products.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.sku_code}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input placeholder="Count" value={l.qty} onChange={e => setFLines(ls => ls.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} className="h-9 w-24" />
              {fLines.length > 1 && (
                <Button size="sm" variant="ghost" className="h-9 px-2 text-red-600" onClick={() => setFLines(ls => ls.filter((_, j) => j !== i))}>✕</Button>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2 items-center">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setFLines(ls => [...ls, { product: '', qty: '' }])}>+ Add product</Button>
            <Input placeholder="Note (optional)" value={fNote} onChange={e => setFNote(e.target.value)} className="h-8 flex-1 min-w-40" />
            <Button size="sm" className="h-8" disabled={fSaving} onClick={createPackage}>{fSaving ? 'Saving…' : 'Create draft'}</Button>
          </div>
          {fMsg && <p className="text-xs text-red-600">{fMsg}</p>}
          <p className="text-[11px] text-muted-foreground">Drafts are editable; Commit on the card starts tracking. Contents count into the address inventory when the package is received.</p>
        </CardContent>
      </Card>

      {/* filters */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2 items-center">
          <Select value={addrFilter} onValueChange={setAddrFilter}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All addresses</SelectItem>
              {addresses.map(a => <SelectItem key={a.id} value={String(a.id)}>{a.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-44 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="incoming">Incoming (not received)</SelectItem>
              <SelectItem value="all">All packages</SelectItem>
              <SelectItem value="out_for_delivery">Out for delivery today</SelectItem>
              <SelectItem value="TRANSIT">In transit</SelectItem>
              <SelectItem value="PRE_TRANSIT">Pre-transit</SelectItem>
              <SelectItem value="attention">Needs attention (failure/returned)</SelectItem>
              <SelectItem value="received">Received</SelectItem>
            </SelectContent>
          </Select>
          <Select value={vendorFilter} onValueChange={setVendorFilter}>
            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All vendors</SelectItem>
              {vendors.map(v => <SelectItem key={v.id} value={v.code}>{v.code}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={refreshAll} disabled={!hasKey}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh all
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={scanBusy}
            title="Photograph a carrier label — the tracking barcode is read and the matching logged package is received"
            onClick={() => scanInputRef.current?.click()}>
            <ScanLine className="w-3.5 h-3.5 mr-1" /> {scanBusy ? 'Reading…' : 'Scan label'}
          </Button>
          <input ref={scanInputRef} type="file" accept="image/*" capture="environment" className="hidden"
            onChange={e => onScanPicked(e.target.files)} />
          {refreshAllProgress && <span className="text-xs text-muted-foreground">{refreshAllProgress}</span>}
        </div>
        {scanMsg && <p className={`text-xs ${scanMsg.startsWith('Received ') ? 'text-green-700' : 'text-amber-700'}`}>{scanMsg}</p>}
        <div className="flex flex-wrap gap-1.5">
          {products.filter(pr => packages.some(p => (p.items || []).some(i => Number(i.product_id) === pr.id))).map(pr => {
            const on = productFilter.has(pr.id);
            return (
              <button key={pr.id}
                className={`rounded text-[11px] font-semibold px-2 py-0.5 ${productChipClass(pr.id)} ${on ? 'ring-2 ring-violet-500' : 'opacity-70'}`}
                onClick={() => setProductFilter(s => { const n = new Set(s); if (n.has(pr.id)) n.delete(pr.id); else n.add(pr.id); return n; })}
                title={on ? 'Filtering by this product — click to clear' : 'Scope the dashboard to addresses expecting this product'}>
                {pr.sku_code}
              </button>
            );
          })}
          {productFilter.size > 0 && (
            <button className="text-[11px] underline text-muted-foreground" onClick={() => setProductFilter(new Set())}>clear products</button>
          )}
        </div>
      </div>

      {/* address cards */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cardAddresses.map(a => {
          const pkgs = visible.filter(p => p.receive_address_id === a.id);
          const incoming = packages.filter(p => p.receive_address_id === a.id && p.committed_at && !p.received_at).length;
          return (
            <Card key={a.id}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">{a.label}{!a.active && <span className="ml-1 text-xs text-muted-foreground">(archived)</span>}</span>
                  <span className="text-xs font-normal text-muted-foreground whitespace-nowrap">{incoming} incoming</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {pkgs.map(p => (
                  <div key={p.id} className="rounded border p-2 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap ${trackClass(p)}`}
                        title={p.tracking_detail || undefined}>
                        {trackLabel(p)}
                      </span>
                      {p.received_at && <span className="rounded bg-green-100 text-green-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title={`Received ${fmtDateTime(p.received_at)} by ${p.received_by}`}>received</span>}
                      {p.vendor_code && <span className="rounded bg-zinc-200 text-zinc-800 text-[10px] font-semibold px-1.5 py-0.5">{p.vendor_code}</span>}
                      {p.eta && !p.received_at && <span className="text-[10px] text-muted-foreground">ETA {fmtDate(p.eta)}</span>}
                    </div>
                    <div className="text-xs font-mono break-all text-muted-foreground" title={p.note || undefined}>
                      {p.carrier.toUpperCase()} · {p.tracking_mangled
                        ? <span className="text-amber-700">(tracking number unreadable here)</span>
                        : p.tracking_number}
                    </div>
                    {p.tracking_mangled && (
                      <p className="text-[11px] rounded border border-amber-300 bg-amber-50 text-amber-900 p-1.5">
                        The platform returned this tracking number rounded (too many digits), so this page can't show or track the real number. The database record is intact — delete this package and re-log it with the exact number from the label.
                      </p>
                    )}
                    {p.tracking_error && <p className="text-[11px] text-red-600">{p.tracking_error}</p>}
                    {p.received_at && p.tracking_status === 'RETURNED' && (
                      <p className="text-[11px] rounded border border-amber-300 bg-amber-50 text-amber-900 p-1.5">Received but tracking now says RETURNED — un-receive if the box left.</p>
                    )}
                    {!p.received_at && p.auto_receive_suppressed && (
                      <p className="text-[11px] text-muted-foreground">Auto-receive is OFF for this package (it was un-received) — use Mark received when it's really here.</p>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {(p.items || []).map(i => (
                        <span key={i.product_id} className={`rounded text-[10px] font-semibold px-1.5 py-0.5 ${productChipClass(Number(i.product_id))}`}>
                          {i.sku_code} × {fmtNum(i.qty)}
                          {!p.received_at && (
                            <button className="ml-1 opacity-60 hover:opacity-100" title="Remove line" onClick={() => removeItemFromCard(p, i.id)}>✕</button>
                          )}
                        </span>
                      ))}
                    </div>
                    {!p.received_at && (
                      <div className="flex flex-wrap gap-1 items-center">
                        <Select value={rowItem[p.id]?.product || ''} onValueChange={v => setRowItem(m => ({ ...m, [p.id]: { product: v, qty: m[p.id]?.qty || '' } }))}>
                          <SelectTrigger className="h-6 w-32 text-[11px]"><SelectValue placeholder="+ product" /></SelectTrigger>
                          <SelectContent>
                            {products.map(pr => <SelectItem key={pr.id} value={String(pr.id)}>{pr.sku_code}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Input placeholder="Count" value={rowItem[p.id]?.qty || ''} onChange={e => setRowItem(m => ({ ...m, [p.id]: { product: m[p.id]?.product || '', qty: e.target.value } }))} className="h-6 w-16 text-[11px]" />
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => addItemToCard(p)}>Add</Button>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {!p.committed_at && <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => commitPkg(p)}>Commit</Button>}
                      {p.committed_at && !p.received_at && (
                        <>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={!hasKey || refreshingIds.has(p.id)}
                            onClick={async () => { const err = await refreshOne(p); setRowMsg(m => ({ ...m, [p.id]: err || '' })); afterChange(); }}>
                            <RefreshCw className={`w-3 h-3 mr-1 ${refreshingIds.has(p.id) ? 'animate-spin' : ''}`} /> Refresh
                          </Button>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => receivePkg(p)}>Mark received</Button>
                        </>
                      )}
                      {!p.received_at && (
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                          onClick={() => { setCorrecting(p); setCCarrier(p.carrier); setCTracking(p.tracking_number); setCMsg(''); }}>
                          Edit tracking
                        </Button>
                      )}
                      {p.received_at && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-amber-700" onClick={() => unreceivePkg(p)}>Un-receive</Button>}
                      {!p.received_at && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-red-600" onClick={() => deletePkg(p)}>Delete</Button>}
                    </div>
                    {rowMsg[p.id] && <p className="text-[11px] text-red-600">{rowMsg[p.id]}</p>}
                  </div>
                ))}
                {pkgs.length === 0 && <p className="text-xs text-muted-foreground">No packages match the filters.</p>}
              </CardContent>
            </Card>
          );
        })}
        {cardAddresses.length === 0 && (
          <Card className="md:col-span-2 xl:col-span-3">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              {addresses.length === 0
                ? 'No receive addresses yet — create one on the Addresses tab.'
                : 'No packages match the current filters.'}
            </CardContent>
          </Card>
        )}
      </div>
      {testMode && <p className="text-[11px] text-amber-700">Test mode: statuses shown are simulated; auto-receive is off.</p>}

      <Dialog open={correcting != null} onOpenChange={o => { if (!o) setCorrecting(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Fix carrier / tracking — {correcting?.address_label}</DialogTitle></DialogHeader>
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted-foreground flex items-start gap-1"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> Saving clears the fetched tracking status (it belonged to the old number). Locked once received.</p>
            <Input placeholder="carrier token (usps, ups, fedex…)" value={cCarrier} onChange={e => setCCarrier(e.target.value)} className="h-9 font-mono text-xs" />
            <Input placeholder="Tracking number" value={cTracking} onChange={e => setCTracking(e.target.value)} className="h-9 font-mono text-xs" />
            {cMsg && <p className="text-xs text-red-600">{cMsg}</p>}
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" onClick={() => setCorrecting(null)}>Cancel</Button>
              <Button size="sm" onClick={saveCorrection}>Save</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
