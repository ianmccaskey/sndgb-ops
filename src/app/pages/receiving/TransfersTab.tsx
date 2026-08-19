import React, { useRef, useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import createTransfer from '@/actions/receiving/createTransfer';
import markTransferPurchaseStarted from '@/actions/receiving/markTransferPurchaseStarted';
import finalizeTransfer from '@/actions/receiving/finalizeTransfer';
import deleteTransferDraft from '@/actions/receiving/deleteTransferDraft';
import setTransferRefund from '@/actions/receiving/setTransferRefund';
import { getRates, purchaseLabel, getTransaction, findTransactionByRate, requestRefund, findRefundByTransaction } from '@/lib/shippo';
import type { ShippoAddress, ShippoRate, PurchaseResult } from '@/lib/shippo';
import { useApp } from '@/app/AppContext';
import { fmtUSD, fmtNum, fmtDate } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { productChipClass } from './shared';
import type { RxAddress, CatalogProduct, TransferRow, InvRow } from './shared';

type ItemLine = { product: string; qty: string };

const toShippoAddress = (a: RxAddress | CustomDest): ShippoAddress => ({
  name: a.name, street1: a.street1, street2: a.street2 || undefined as unknown as string,
  city: a.city, state: a.state, zip: a.zip, country: a.country || 'US',
  phone: a.phone || undefined as unknown as string, email: a.email || undefined as unknown as string,
});
type CustomDest = { name: string; street1: string; street2: string; city: string; state: string; zip: string; country: string; phone: string; email: string };
const EMPTY_DEST: CustomDest = { name: '', street1: '', street2: '', city: '', state: '', zip: '', country: 'US', phone: '', email: '' };

export function TransfersTab({ addresses, destinations, products, transfers, inventory, shippoKey, testMode, reloadTransfers, reloadDestinations }: {
  addresses: RxAddress[]; destinations: RxAddress[]; products: CatalogProduct[];
  transfers: TransferRow[]; inventory: InvRow[]; shippoKey: string; testMode: boolean;
  reloadTransfers: () => void; reloadDestinations: () => void;
}) {
  void reloadDestinations;
  const { userName } = useApp();
  const [doCreate] = useMutateAction(createTransfer);
  const [doClaimPurchase] = useMutateAction(markTransferPurchaseStarted);
  const [doFinalize] = useMutateAction(finalizeTransfer);
  const [doDeleteDraft] = useMutateAction(deleteTransferDraft);
  const [doSetRefund] = useMutateAction(setTransferRefund);

  const [fFrom, setFFrom] = useState('');
  const [fDest, setFDest] = useState('');      // destination id or '__custom__'
  const [custom, setCustom] = useState<CustomDest>(EMPTY_DEST);
  const [dims, setDims] = useState({ length: '', width: '', height: '', weight: '' });
  const [fLines, setFLines] = useState<ItemLine[]>([{ product: '', qty: '' }]);
  const [fNote, setFNote] = useState('');
  const [fMsg, setFMsg] = useState('');
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesResult, setRatesResult] = useState<{ rates: ShippoRate[]; allRateCount: number; messages: string[]; sig: string } | null>(null);
  const [pickedRate, setPickedRate] = useState('');
  const [purchaseMsg, setPurchaseMsg] = useState('');
  const [success, setSuccess] = useState<PurchaseResult | null>(null);
  // purchase results that landed but failed to persist — retry finalize
  // WITHOUT re-buying (keyed by draft id)
  const [pendingFinalize, setPendingFinalize] = useState<Record<number, PurchaseResult>>({});
  const [recoverTxn, setRecoverTxn] = useState<Record<number, string>>({});
  const [draftMsg, setDraftMsg] = useState<Record<number, string>>({});
  // ref, not state: React re-renders lag double-clicks, and this button
  // spends REAL money
  const purchaseInFlight = useRef(false);
  const [purchasing, setPurchasing] = useState(false);

  const destAddress = (): ShippoAddress | null => {
    if (fDest === '__custom__') {
      if (!custom.name || !custom.street1 || !custom.city || !custom.state || !custom.zip) return null;
      return toShippoAddress(custom);
    }
    const d = destinations.find(x => String(x.id) === fDest);
    return d ? toShippoAddress(d) : null;
  };
  const destLabel = fDest === '__custom__' ? (custom.name || 'custom') : (destinations.find(x => String(x.id) === fDest)?.label || '');

  const onHand = (productId: number) =>
    Number(inventory.find(r => String(r.receive_address_id) === fFrom && r.product_id === productId)?.on_hand_qty || 0);

  // signature of every input the RATE depends on — a quote fetched for one
  // shipment must never buy a label while the form describes another. Any
  // edit to ship-from, destination, or parcel invalidates fetched rates.
  const quoteSig = JSON.stringify({ fFrom, fDest, custom, dims });
  React.useEffect(() => {
    if (ratesResult && ratesResult.sig !== quoteSig) { setRatesResult(null); setPickedRate(''); setPurchaseMsg(''); }
  }, [quoteSig, ratesResult]);

  // shared by fetchRates AND purchase — the item lines are re-validated at
  // purchase time because the operator can edit them after rates arrive; a
  // label must never be bought for a transfer with zero or invalid lines
  const validateLines = (): { lines: ItemLine[]; error: string | null } => {
    const lines = fLines.filter(l => l.product && l.qty.trim());
    if (lines.length === 0) return { lines, error: 'Add at least one product line — transfers decrement the address inventory.' };
    for (const l of lines) {
      if (!/^\d+(?:\.\d{1,2})?$/.test(l.qty.trim()) || !(Number(l.qty) > 0)) return { lines, error: 'Every line needs a positive count.' };
    }
    // duplicate SKUs would collide on the items UNIQUE — refuse before any
    // money is near this form
    if (new Set(lines.map(l => l.product)).size !== lines.length) {
      return { lines, error: 'The same product appears on two lines — combine them into one line.' };
    }
    return { lines, error: null };
  };

  const fetchRates = async () => {
    setFMsg(''); setRatesResult(null); setPickedRate('');
    if (!shippoKey) { setFMsg('Add your Shippo API token in Settings first.'); return; }
    const from = addresses.find(a => String(a.id) === fFrom);
    if (!from) { setFMsg('Pick the ship-from receive address.'); return; }
    const to = destAddress();
    if (!to) { setFMsg('Destination incomplete — name, street, city, state, and zip are required.'); return; }
    for (const k of ['length', 'width', 'height', 'weight'] as const) {
      if (!/^\d+(?:\.\d{1,2})?$/.test(dims[k].trim()) || !(Number(dims[k]) > 0)) { setFMsg('Dimensions and weight must be positive numbers (inches / lbs).'); return; }
    }
    const { error: lineError } = validateLines();
    if (lineError) { setFMsg(lineError); return; }
    setRatesLoading(true);
    try {
      const res = await getRates(shippoKey, toShippoAddress(from), to, {
        length: dims.length.trim(), width: dims.width.trim(), height: dims.height.trim(),
        distance_unit: 'in', weight: dims.weight.trim(), mass_unit: 'lb',
      });
      setRatesResult({ ...res, sig: quoteSig });
    } catch (e: unknown) {
      setFMsg(e instanceof Error ? e.message : 'Failed to fetch rates');
    } finally {
      setRatesLoading(false);
    }
  };

  const purchase = async () => {
    if (purchaseInFlight.current) return;   // synchronous double-click guard
    purchaseInFlight.current = true;
    setPurchasing(true); setPurchaseMsg('');
    try {
      const rate = ratesResult?.rates.find(r => r.object_id === pickedRate);
      const to = destAddress();
      if (!rate || !to) { setPurchaseMsg('Pick a rate first.'); return; }
      // belt for races the invalidation effect can't win: the quote must
      // describe EXACTLY the shipment on screen, or Shippo is charged for
      // one shipment while the log records another
      if (ratesResult!.sig !== quoteSig) {
        setPurchaseMsg('The shipment details changed after these rates were fetched — re-fetch rates.');
        setRatesResult(null); setPickedRate('');
        return;
      }
      // the lines are re-validated NOW, not just at rate time — the
      // operator can edit them after rates arrive, and a label must never
      // be purchased for a transfer with zero or invalid contents
      const { lines, error: lineError } = validateLines();
      if (lineError) { setPurchaseMsg(lineError + ' Nothing was purchased.'); return; }
      // 1. DRAFT FIRST, ATOMIC WITH ITS ITEMS: a failed purchase leaves a
      //    visible draft with its full contents; a succeeded purchase
      //    always has a complete home to finalize into. The insert also
      //    stamps the purchase lease (blocks concurrent draft deletion).
      let draftId: number | null = null;
      try {
        const res = await doCreate({
          from_address_id: Number(fFrom), destination_label: destLabel,
          destination: JSON.stringify(to),
          parcel: JSON.stringify({ length: dims.length.trim(), width: dims.width.trim(), height: dims.height.trim(), distance_unit: 'in', weight: dims.weight.trim(), mass_unit: 'lb' }),
          carrier: rate.provider, servicelevel: rate.servicelevel?.name || rate.servicelevel?.token || '',
          rate_amount: rate.amount, rate_currency: rate.currency, shippo_rate_id: rate.object_id,
          items: JSON.stringify(lines.map(l => ({ product_id: Number(l.product), qty: l.qty.trim() }))),
          note: fNote.trim(), actor: userName,
        }) as unknown[] | null;
        draftId = Array.isArray(res) && res.length > 0 ? Number((res[0] as { id: string }).id) : null;
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : '';
        setPurchaseMsg(m.includes('transfers_rate_unique')
          ? 'This exact rate was already purchased (double-click?) — check the transfer log before buying again.'
          : (m || 'Failed to save the transfer draft.') + ' Nothing was saved or purchased.');
        return;
      }
      if (!draftId) { setPurchaseMsg('Draft not saved — nothing was purchased. Check every line has a positive count.'); return; }
      // 2. buy the label (single attempt inside)
      let result: PurchaseResult;
      try {
        result = await purchaseLabel(shippoKey, rate.object_id);
      } catch (e: unknown) {
        setPurchaseMsg((e instanceof Error ? e.message : 'Purchase failed') + ' — the draft is saved below; retry or delete it there.');
        reloadTransfers();
        return;
      }
      // 3. persist — retryable from memory if this write fails
      const fin = await doFinalize({
        transfer_id: draftId, transaction_id: result.transactionId,
        tracking_number: result.trackingNumber, label_url: result.labelUrl,
        // finalize proves rate ownership server-side; Shippo's reported rate
        // first, with the rate we POSTed as the fallback (same rate by
        // construction — we bought exactly rate.object_id)
        rate_id: result.rateId || rate.object_id, actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(fin) ? fin.length > 0 : !!fin)) {
        setPendingFinalize(m => ({ ...m, [draftId!]: result }));
        setPurchaseMsg(`LABEL PURCHASED (transaction ${result.transactionId}) but saving failed — label: ${result.labelUrl} — use "Retry save" on the draft below; do NOT purchase again.`);
        reloadTransfers();
        return;
      }
      setSuccess(result);
      setRatesResult(null); setPickedRate(''); setFLines([{ product: '', qty: '' }]); setFNote('');
      reloadTransfers();
    } finally {
      purchaseInFlight.current = false;
      setPurchasing(false);
    }
  };

  const retryFinalize = async (t: TransferRow) => {
    const pending = pendingFinalize[t.id];
    if (!pending) return;
    const fin = await doFinalize({ transfer_id: t.id, transaction_id: pending.transactionId, tracking_number: pending.trackingNumber, label_url: pending.labelUrl, rate_id: pending.rateId || t.shippo_rate_id || '', actor: userName }) as unknown[] | null;
    if (Array.isArray(fin) ? fin.length > 0 : !!fin) {
      setPendingFinalize(m => { const n = { ...m }; delete n[t.id]; return n; });
      setDraftMsg(m => ({ ...m, [t.id]: '' }));
      reloadTransfers();
    } else setDraftMsg(m => ({ ...m, [t.id]: 'Save failed again — the label URL is preserved here; keep retrying.' }));
  };

  const recoverByTxn = async (t: TransferRow) => {
    const txn = (recoverTxn[t.id] || '').trim();
    if (!txn) { setDraftMsg(m => ({ ...m, [t.id]: 'Paste the transaction id from the error message or the Shippo dashboard.' })); return; }
    try {
      const result = await getTransaction(shippoKey, txn);
      // RATE-BOUND: a pasted id can be any label in the account — attaching
      // one bought against a different rate would finalize the WRONG draft
      // and decrement the wrong inventory. The draft's stored rate is the
      // proof of ownership.
      if (!t.shippo_rate_id || result.rateId !== t.shippo_rate_id) {
        setDraftMsg(m => ({ ...m, [t.id]: `That transaction was purchased against a different rate than this draft (transaction rate ${result.rateId || 'unknown'}, draft rate ${t.shippo_rate_id || 'missing'}) — refusing to attach it. Find the right transaction in the Shippo dashboard.` }));
        return;
      }
      const fin = await doFinalize({ transfer_id: t.id, transaction_id: result.transactionId, tracking_number: result.trackingNumber, label_url: result.labelUrl, rate_id: result.rateId || '', actor: userName }) as unknown[] | null;
      if (Array.isArray(fin) ? fin.length > 0 : !!fin) { setDraftMsg(m => ({ ...m, [t.id]: '' })); reloadTransfers(); }
      else setDraftMsg(m => ({ ...m, [t.id]: 'Transaction found but saving failed — retry.' }));
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Recovery failed' }));
    }
  };

  const retryPurchase = async (t: TransferRow) => {
    if (purchaseInFlight.current || !t.shippo_rate_id) return;
    purchaseInFlight.current = true;
    try {
      // RELOAD-SAFE: ask Shippo whether this rate was already bought before
      // any re-purchase — a label paid for in a lost browser session is
      // recovered here instead of being bought twice
      let existing: Awaited<ReturnType<typeof findTransactionByRate>>;
      try {
        existing = await findTransactionByRate(shippoKey, t.shippo_rate_id);
      } catch (e: unknown) {
        setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Could not verify with Shippo — not purchasing.' }));
        return;
      }
      if (existing) {
        const fin0 = await doFinalize({ transfer_id: t.id, transaction_id: existing.transactionId, tracking_number: existing.trackingNumber, label_url: existing.labelUrl, rate_id: existing.rateId || t.shippo_rate_id, actor: userName }) as unknown[] | null;
        if (Array.isArray(fin0) ? fin0.length > 0 : !!fin0) { setDraftMsg(m => ({ ...m, [t.id]: '' })); reloadTransfers(); }
        else setDraftMsg(m => ({ ...m, [t.id]: `An existing label was found (${existing.transactionId}) but saving failed — retry.` }));
        return;
      }
      if (!window.confirm('No existing label found at Shippo for this rate. Buy it now? Note: rates expire after ~7 days.')) return;
      // re-claim the purchase lease BEFORE money moves: zero rows means the
      // draft was deleted or finalized in another session — abort; a claim
      // also blocks concurrent deletion for the next 10 minutes
      const claim = await doClaimPurchase({ transfer_id: t.id, actor: userName }) as unknown[] | null;
      if (!(Array.isArray(claim) ? claim.length > 0 : !!claim)) {
        setDraftMsg(m => ({ ...m, [t.id]: 'This draft no longer exists (deleted or finalized in another session) — nothing was purchased. Reload the page.' }));
        reloadTransfers();
        return;
      }
      const result = await purchaseLabel(shippoKey, t.shippo_rate_id);
      const fin = await doFinalize({ transfer_id: t.id, transaction_id: result.transactionId, tracking_number: result.trackingNumber, label_url: result.labelUrl, rate_id: result.rateId || t.shippo_rate_id, actor: userName }) as unknown[] | null;
      if (Array.isArray(fin) ? fin.length > 0 : !!fin) { setDraftMsg(m => ({ ...m, [t.id]: '' })); reloadTransfers(); }
      else {
        setPendingFinalize(m => ({ ...m, [t.id]: result }));
        setDraftMsg(m => ({ ...m, [t.id]: `Label purchased (${result.transactionId}) but saving failed — ${result.labelUrl} — use Retry save.` }));
      }
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Purchase failed' }));
    } finally {
      purchaseInFlight.current = false;
    }
  };

  const deleteDraft = async (t: TransferRow) => {
    // HARD GUARD: a draft may only be deleted after Shippo PROVES no label
    // was purchased against its rate — the draft's rate id is the ONLY
    // recovery handle for a label paid in a lost session, and deleting it
    // unverified would orphan real money. No key = no verification = no delete.
    if (!shippoKey) {
      setDraftMsg(m => ({ ...m, [t.id]: 'Not deleted — no Shippo API token is set, so it cannot be verified that no label was purchased for this draft. Add the token in Settings, then delete.' }));
      return;
    }
    if (!t.shippo_rate_id) {
      setDraftMsg(m => ({ ...m, [t.id]: 'Not deleted — this draft has no rate id to verify against Shippo. Check the Shippo dashboard manually.' }));
      return;
    }
    try {
      const existing = await findTransactionByRate(shippoKey, t.shippo_rate_id);
      if (existing) {
        const fin = await doFinalize({ transfer_id: t.id, transaction_id: existing.transactionId, tracking_number: existing.trackingNumber, label_url: existing.labelUrl, rate_id: existing.rateId || t.shippo_rate_id, actor: userName }) as unknown[] | null;
        setDraftMsg(m => ({ ...m, [t.id]: (Array.isArray(fin) && fin.length > 0)
          ? ''
          : `A PURCHASED label exists for this draft (${existing.transactionId}) — recovered instead of deleting${!(Array.isArray(fin) && fin.length > 0) ? ', but saving failed — retry' : ''}.` }));
        reloadTransfers();
        return;
      }
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Could not verify with Shippo — not deleting.' }));
      return;
    }
    if (!window.confirm(`Delete this draft transfer from ${t.from_label}? Shippo confirmed no label was purchased for it.`)) return;
    // the action refuses while the purchase lease is fresh (<10 min) — a
    // purchase may be in flight in another session and this rate id is its
    // only recovery handle
    const del = await doDeleteDraft({ transfer_id: t.id, actor: userName }) as unknown[] | null;
    if (!(Array.isArray(del) ? del.length > 0 : !!del)) {
      setDraftMsg(m => ({ ...m, [t.id]: 'Not deleted — a purchase attempt for this draft started within the last 10 minutes (possibly in another session), or it was just finalized. Wait for it to settle, then use "Check Shippo & retry" or delete again.' }));
      reloadTransfers();
      return;
    }
    reloadTransfers();
  };

  const refund = async (t: TransferRow) => {
    if (!t.shippo_transaction_id) return;
    if (!window.confirm(`Request a refund for this label (${fmtUSD(t.rate_amount)})? USPS refunds settle over days — final status shows in the Shippo dashboard. The transfer stays in the log marked refund-requested; its items still count as transferred until you delete the transfer via Shippo support if the shipment never went.`)) return;
    // persist the intent BEFORE the POST — if the browser dies mid-request
    // the row shows REQUESTING (which hides the refund button) instead of
    // silently looking refundable while Shippo may already hold a request
    const mark = await doSetRefund({ transfer_id: t.id, refund_status: 'REQUESTING', actor: userName }) as unknown[] | null;
    if (!(Array.isArray(mark) ? mark.length > 0 : !!mark)) {
      setDraftMsg(m => ({ ...m, [t.id]: 'Could not record the refund request — nothing was sent to Shippo. Retry.' }));
      return;
    }
    reloadTransfers();
    try {
      const status = await requestRefund(shippoKey, t.shippo_transaction_id);
      await doSetRefund({ transfer_id: t.id, refund_status: status, actor: userName });
      reloadTransfers();
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: (e instanceof Error ? e.message : 'Refund request failed') + ' The row stays marked REQUESTING — use "Re-check" to reconcile with Shippo; do not assume it failed.' }));
    }
  };

  // reconcile a stuck/uncertain refund with Shippo: an exhaustive listing
  // either finds the refund (record its real status) or proves none exists
  // (clear the marker so the button returns)
  const recheckRefund = async (t: TransferRow) => {
    if (!t.shippo_transaction_id) return;
    try {
      const status = await findRefundByTransaction(shippoKey, t.shippo_transaction_id);
      if (status) {
        await doSetRefund({ transfer_id: t.id, refund_status: status, actor: userName });
        setDraftMsg(m => ({ ...m, [t.id]: '' }));
      } else {
        await doSetRefund({ transfer_id: t.id, refund_status: '', actor: userName });
        setDraftMsg(m => ({ ...m, [t.id]: 'Shippo has NO refund for this label — the earlier request never landed. You can request again.' }));
      }
      reloadTransfers();
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Refund check failed' }));
    }
  };

  const drafts = transfers.filter(t => !t.finalized_at);
  const finalized = transfers.filter(t => !!t.finalized_at);
  const labelSpendTotal = finalized.reduce((s, t) => s + Number(t.rate_amount || 0), 0);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">New transfer — buy a label via Shippo</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Select value={fFrom} onValueChange={setFFrom}>
              <SelectTrigger className="h-9 flex-1 min-w-40"><SelectValue placeholder="Ship from (receive address)" /></SelectTrigger>
              <SelectContent>
                {addresses.filter(a => a.active).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={fDest} onValueChange={setFDest}>
              <SelectTrigger className="h-9 flex-1 min-w-40"><SelectValue placeholder="Destination" /></SelectTrigger>
              <SelectContent>
                {destinations.filter(d => d.active).map(d => <SelectItem key={d.id} value={String(d.id)}>{d.label}</SelectItem>)}
                <SelectItem value="__custom__">Custom address…</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {fDest === '__custom__' && (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Input placeholder="Name" value={custom.name} onChange={e => setCustom(c => ({ ...c, name: e.target.value }))} className="h-9 col-span-2 sm:col-span-1" />
              <Input placeholder="Street" value={custom.street1} onChange={e => setCustom(c => ({ ...c, street1: e.target.value }))} className="h-9 col-span-2" />
              <Input placeholder="Apt / unit" value={custom.street2} onChange={e => setCustom(c => ({ ...c, street2: e.target.value }))} className="h-9" />
              <Input placeholder="City" value={custom.city} onChange={e => setCustom(c => ({ ...c, city: e.target.value }))} className="h-9" />
              <Input placeholder="State" value={custom.state} onChange={e => setCustom(c => ({ ...c, state: e.target.value }))} className="h-9" />
              <Input placeholder="Zip" value={custom.zip} onChange={e => setCustom(c => ({ ...c, zip: e.target.value }))} className="h-9" />
              <Input placeholder="Phone (optional)" value={custom.phone} onChange={e => setCustom(c => ({ ...c, phone: e.target.value }))} className="h-9" />
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Input placeholder="Length (in)" value={dims.length} onChange={e => setDims(d => ({ ...d, length: e.target.value }))} className="h-9" />
            <Input placeholder="Width (in)" value={dims.width} onChange={e => setDims(d => ({ ...d, width: e.target.value }))} className="h-9" />
            <Input placeholder="Height (in)" value={dims.height} onChange={e => setDims(d => ({ ...d, height: e.target.value }))} className="h-9" />
            <Input placeholder="Weight (lb)" value={dims.weight} onChange={e => setDims(d => ({ ...d, weight: e.target.value }))} className="h-9" />
          </div>
          {fLines.map((l, i) => {
            const oh = l.product ? onHand(Number(l.product)) : null;
            const over = l.product && Number(l.qty) > (oh ?? 0);
            return (
              <div key={i} className="flex flex-wrap gap-2 items-center">
                <Select value={l.product} onValueChange={v => setFLines(ls => ls.map((x, j) => j === i ? { ...x, product: v } : x))}>
                  <SelectTrigger className="h-9 flex-1 min-w-44"><SelectValue placeholder="Product" /></SelectTrigger>
                  <SelectContent>
                    {products.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.sku_code}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input placeholder="Count" value={l.qty} onChange={e => setFLines(ls => ls.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} className="h-9 w-24" />
                {fLines.length > 1 && <Button size="sm" variant="ghost" className="h-9 px-2 text-red-600" onClick={() => setFLines(ls => ls.filter((_, j) => j !== i))}>✕</Button>}
                {l.product && fFrom && (
                  <span className={`text-[11px] ${over ? 'text-amber-700 font-medium' : 'text-muted-foreground'}`}>
                    {over ? `only ${fmtNum(oh ?? 0)} on hand — sending more is allowed but check the box` : `${fmtNum(oh ?? 0)} on hand`}
                  </span>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2 items-center">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setFLines(ls => [...ls, { product: '', qty: '' }])}>+ Add product</Button>
            <Input placeholder="Note (optional)" value={fNote} onChange={e => setFNote(e.target.value)} className="h-8 flex-1 min-w-40" />
            <Button size="sm" className="h-8" onClick={fetchRates} disabled={ratesLoading}>{ratesLoading ? 'Fetching rates…' : 'Get rates (UPS / USPS)'}</Button>
          </div>
          {fMsg && <p className="text-xs text-red-600">{fMsg}</p>}

          {ratesResult && (
            <div className="space-y-2 border-t pt-2">
              {ratesResult.messages.length > 0 && (
                <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                  Shippo messages: {ratesResult.messages.join(' · ')}
                </div>
              )}
              {ratesResult.rates.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No UPS/USPS rates returned.
                  {ratesResult.allRateCount > 0
                    ? ' Other carriers returned rates, but this form is limited to UPS and USPS.'
                    : ' If the address is fine, UPS may not be enabled on your Shippo account (Shippo dashboard → Carriers); USPS is on by default.'}
                </p>
              )}
              {ratesResult.rates.length > 0 && (
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead></TableHead>
                        <TableHead>Carrier</TableHead>
                        <TableHead>Service</TableHead>
                        <TableHead className="text-right">Price</TableHead>
                        <TableHead>Days</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {ratesResult.rates.map(r => (
                        <TableRow key={r.object_id} className="cursor-pointer" onClick={() => setPickedRate(r.object_id)}>
                          <TableCell><input type="radio" checked={pickedRate === r.object_id} onChange={() => setPickedRate(r.object_id)} aria-label="pick rate" /></TableCell>
                          <TableCell>{r.provider}</TableCell>
                          <TableCell>{r.servicelevel?.name || r.servicelevel?.token}</TableCell>
                          <TableCell className="text-right font-medium">{fmtUSD(r.amount)}</TableCell>
                          <TableCell>{r.estimated_days ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {pickedRate && (
                <Button size="sm" disabled={purchasing} onClick={purchase}>
                  {purchasing ? 'Purchasing…' : `Buy label — ${fmtUSD(ratesResult.rates.find(r => r.object_id === pickedRate)?.amount)}${testMode ? ' (TEST)' : ''}`}
                </Button>
              )}
              {purchaseMsg && <p className="text-xs text-red-600 break-all">{purchaseMsg}</p>}
            </div>
          )}
          {success && (
            <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900 space-y-1">
              <p className="font-semibold">Label purchased and saved.</p>
              <p className="text-xs">Tracking: <span className="font-mono">{success.trackingNumber || '—'}</span></p>
              <p className="text-xs">
                <a href={success.labelUrl} target="_blank" rel="noreferrer" className="underline font-medium">Open label (PDF)</a>
                {' '}— public unauthenticated link, don't share.
              </p>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSuccess(null)}>Done</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Unfinished drafts — no label saved yet</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {drafts.map(t => (
              <div key={t.id} className="rounded border p-2 space-y-1.5 text-sm">
                <div className="flex flex-wrap gap-2 items-center">
                  <span className="font-medium">{t.from_label} → {t.destination_label}</span>
                  <span className="text-xs text-muted-foreground">{t.carrier} {t.servicelevel} · {fmtUSD(t.rate_amount)} · {fmtDate(t.created_at)}</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(t.items || []).map(i => (
                    <span key={i.product_id} className={`rounded text-[10px] font-semibold px-1.5 py-0.5 ${productChipClass(i.product_id)}`}>{i.sku_code} × {fmtNum(i.qty)}</span>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  {pendingFinalize[t.id]
                    ? <Button size="sm" className="h-7 text-xs" onClick={() => retryFinalize(t)}>Retry save (label already purchased)</Button>
                    : <Button size="sm" variant="outline" className="h-7 text-xs" title="Checks Shippo for an already-purchased label first — recovers it if found, only buys if none exists" onClick={() => retryPurchase(t)}>Check Shippo & retry</Button>}
                  <Input placeholder="…or recover by transaction id" value={recoverTxn[t.id] || ''} onChange={e => setRecoverTxn(m => ({ ...m, [t.id]: e.target.value }))} className="h-7 w-56 text-xs font-mono" />
                  <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => recoverByTxn(t)}>Recover</Button>
                  {!pendingFinalize[t.id] && <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600" onClick={() => deleteDraft(t)}>Delete draft</Button>}
                </div>
                {draftMsg[t.id] && <p className="text-xs text-red-600 break-all">{draftMsg[t.id]}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Transfer log</span>
            <span className="text-xs font-normal text-muted-foreground">labels total {fmtUSD(labelSpendTotal)} (not booked to P&L)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>From → To</TableHead>
                  <TableHead>Contents</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead>Tracking</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {finalized.map(t => (
                  <TableRow key={t.id}>
                    <TableCell className="text-xs whitespace-nowrap">{fmtDate(t.finalized_at)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap" title={t.note || undefined}>{t.from_label} → {t.destination_label}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1 max-w-52">
                        {(t.items || []).map(i => (
                          <span key={i.product_id} className={`rounded text-[10px] font-semibold px-1.5 py-0.5 whitespace-nowrap ${productChipClass(i.product_id)}`}>{i.sku_code} × {fmtNum(i.qty)}</span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{t.carrier} {t.servicelevel}</TableCell>
                    <TableCell className="text-right">{fmtUSD(t.rate_amount)}</TableCell>
                    <TableCell className="text-xs font-mono break-all max-w-40">{t.tracking_number || '—'}</TableCell>
                    <TableCell>
                      {t.label_url && <a href={t.label_url} target="_blank" rel="noreferrer" className="text-xs underline whitespace-nowrap" title="Public unauthenticated link — don't share">Label PDF</a>}
                    </TableCell>
                    <TableCell>
                      {t.refund_status
                        ? <span className="inline-flex items-center gap-1">
                            <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap" title="Check the Shippo dashboard for the final refund outcome">refund {t.refund_status}</span>
                            <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" title="Ask Shippo for this refund's real status — records it, or clears the marker if no refund exists" onClick={() => recheckRefund(t)}>Re-check</Button>
                          </span>
                        : <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => refund(t)}>Request refund</Button>}
                      {draftMsg[t.id] && <p className="text-[11px] text-red-600">{draftMsg[t.id]}</p>}
                    </TableCell>
                  </TableRow>
                ))}
                {finalized.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6 text-sm">No transfers yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
