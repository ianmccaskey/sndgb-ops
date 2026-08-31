import React, { useRef, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import createTransfer from '@/actions/receiving/createTransfer';
import createManualTransfer from '@/actions/receiving/createManualTransfer';
import listDirectShipCandidates from '@/actions/receiving/listDirectShipCandidates';
import markTransferPurchaseStarted from '@/actions/receiving/markTransferPurchaseStarted';
import clearTransferPurchaseLease from '@/actions/receiving/clearTransferPurchaseLease';
import clearTransferAttemptVerified from '@/actions/receiving/clearTransferAttemptVerified';
import finalizeTransfer from '@/actions/receiving/finalizeTransfer';
import deleteTransferDraft from '@/actions/receiving/deleteTransferDraft';
import setTransferRefund from '@/actions/receiving/setTransferRefund';
import { getRates, purchaseLabel, getTransaction, findTransactionByRate, requestRefund, findRefundByTransaction, ShippoPurchaseRefusedError } from '@/lib/shippo';
import type { ShippoAddress, ShippoRate, PurchaseResult } from '@/lib/shippo';
import type { ShippoHttp } from '@/lib/useShippoHttp';
import { useApp } from '@/app/AppContext';
import { fmtUSD, fmtNum, fmtDate } from '@/lib/fmt';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { rows } from '@/lib/rows';
import { productChipClass } from './shared';
import type { RxAddress, CatalogProduct, TransferRow, InvRow, Pkg, DirectShipCandidate } from './shared';

type ItemLine = { product: string; qty: string };

// row boundary: the platform transport re-types digit-only text (ZIPs,
// phones) as JS numbers — Shippo 400s numeric zips and the fns' jsonb
// CAS distinguishes 29583 from "29583". sT re-strings (''-coercing for
// payloads); sN preserves NULL for the exact-equality expected_from/
// expected_destination snapshots (jsonb null must stay null).
const sT = (v: unknown): string => (v == null ? '' : String(v));
const sN = (v: unknown): string | null => (v == null ? null : String(v));
const toShippoAddress = (a: RxAddress | CustomDest): ShippoAddress => ({
  name: sT(a.name), street1: sT(a.street1), street2: sT(a.street2) || undefined as unknown as string,
  city: sT(a.city), state: sT(a.state), zip: sT(a.zip), country: sT(a.country) || 'US',
  phone: sT(a.phone) || undefined as unknown as string, email: sT(a.email) || undefined as unknown as string,
});
type CustomDest = { name: string; street1: string; street2: string; city: string; state: string; zip: string; country: string; phone: string; email: string };
const EMPTY_DEST: CustomDest = { name: '', street1: '', street2: '', city: '', state: '', zip: '', country: 'US', phone: '', email: '' };

export function TransfersTab({ addresses, destinations, products, packages, transfers, inventory, shippoKey, shippoHttp, testMode, reloadTransfers, reloadDestinations }: {
  addresses: RxAddress[]; destinations: RxAddress[]; products: CatalogProduct[]; packages: Pkg[];
  transfers: TransferRow[]; inventory: InvRow[]; shippoKey: string; shippoHttp: ShippoHttp; testMode: boolean;
  reloadTransfers: () => void; reloadDestinations: () => void;
}) {
  void reloadDestinations;
  const { userName, groupBuyId } = useApp();
  // outstanding vendor-direct order lines (money-gated server-side) —
  // offered as destinations when the transfer carries their product
  const [rawDirectShips, , , reloadDirectShips] = useLoadAction(listDirectShipCandidates, [groupBuyId], { group_buy_id: groupBuyId }, { enabled: groupBuyId != null });
  const allDirectShips = rows<DirectShipCandidate>(rawDirectShips);
  // the action fetches 1001 as an overflow sentinel — never silently
  // hide eligible lines behind the window
  const directShipsOverflow = allDirectShips.length > 1000;
  const directShips = directShipsOverflow ? allDirectShips.slice(0, 1000) : allDirectShips;
  const [doCreate] = useMutateAction(createTransfer);
  const [doCreateManual] = useMutateAction(createManualTransfer);
  const [doClaimPurchase] = useMutateAction(markTransferPurchaseStarted);
  const [doClearLease] = useMutateAction(clearTransferPurchaseLease);
  const [doClearAttempt] = useMutateAction(clearTransferAttemptVerified);
  const [doFinalize] = useMutateAction(finalizeTransfer);
  const [doDeleteDraft] = useMutateAction(deleteTransferDraft);
  const [doSetRefund] = useMutateAction(setTransferRefund);

  const [fFrom, setFFrom] = useState('');
  // address GROUP: transfers ship from an ORIGIN address; stock received
  // at any address whose transfer_origin_id points at it counts as the
  // origin's (mirrors the server fns' COALESCE(transfer_origin_id, id))
  const groupMemberIds = React.useMemo(() => {
    const origin = Number(fFrom || 0);
    return new Set(addresses
      .filter(a => Number(a.transfer_origin_id ?? a.id) === origin)
      .map(a => Number(a.id)));
  }, [addresses, fFrom]);
  const [fDest, setFDest] = useState('');      // destination id, '__custom__', 'ds_<order item id>', or 'ra_<receive address id>'
  // the received box whose contents were loaded into the item lines —
  // purely a form-filling aid; the transfer itself stays product+qty based
  const [selectedBoxId, setSelectedBoxId] = useState<number | null>(null);
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
  // outcome line for the linked direct-ship order (stamped / already done)
  const [successDirect, setSuccessDirect] = useState('');
  // manual-label mode: the label was bought OUTSIDE the app — no rate
  // shopping, no Shippo purchase; the operator enters carrier + tracking
  // (+ optional cost) and the transfer is recorded born-finalized
  const [manualMode, setManualMode] = useState(false);
  const [mCarrier, setMCarrier] = useState('usps');
  const [mCarrierOther, setMCarrierOther] = useState('');
  const [mTracking, setMTracking] = useState('');
  const [mCost, setMCost] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualSuccess, setManualSuccess] = useState('');   // recorded tracking number
  // purchase results that landed but failed to persist — retry finalize
  // WITHOUT re-buying (keyed by draft id)
  const [pendingFinalize, setPendingFinalize] = useState<Record<number, PurchaseResult>>({});
  const [recoverTxn, setRecoverTxn] = useState<Record<number, string>>({});
  const [draftMsg, setDraftMsg] = useState<Record<number, string>>({});
  // refs, not state: React re-renders lag double-clicks, and these buttons
  // spend REAL money — or, for manual records, write a FINALIZED transfer
  // that immediately moves inventory
  const purchaseInFlight = useRef(false);
  const refundInFlight = useRef(false);
  const manualInFlight = useRef(false);
  const [purchasing, setPurchasing] = useState(false);

  // EVERY post-purchase finalize goes through here: a THROWN action
  // failure (transport error, timeout) is treated exactly like a zero-row
  // refusal, so the caller's recovery branch (pendingFinalize + label URL
  // + transaction id) always runs — a charged label must never lose its
  // recovery handles to an exception path
  const persistFinalize = async (transferId: number, result: PurchaseResult, rateFallback: string): Promise<{ ok: boolean; directItemId: number | null; directStamped: boolean; linkReclaimed: boolean }> => {
    try {
      const fin = await doFinalize({
        transfer_id: transferId, transaction_id: result.transactionId,
        tracking_number: result.trackingNumber, label_url: result.labelUrl,
        rate_id: result.rateId || rateFallback, actor: userName,
      }) as unknown[] | null;
      const row = Array.isArray(fin) && fin.length > 0 ? fin[0] as { direct_order_item_id: string | null; direct_link_reclaimed_at: string | null; direct_stamped: string | number } : null;
      if (!row) return { ok: false, directItemId: null, directStamped: false, linkReclaimed: false };
      // the draft's linked direct-ship order line completes inside the same
      // finalize statement; report whether the stamp actually landed (it
      // refuses harmlessly if the line was fulfilled/removed meanwhile).
      // linkReclaimed = this draft LOST its reservation to a newer draft
      // before the label was recovered: the label is ORPHANED — warn.
      if (row.direct_order_item_id != null) reloadDirectShips();
      return {
        ok: true,
        directItemId: row.direct_order_item_id != null ? Number(row.direct_order_item_id) : null,
        directStamped: Number(row.direct_stamped) > 0,
        linkReclaimed: row.direct_link_reclaimed_at != null,
      };
    } catch {
      return { ok: false, directItemId: null, directStamped: false, linkReclaimed: false };
    }
  };

  // the direct-ship order line currently picked as the destination
  const directCandidate = fDest.startsWith('ds_')
    ? directShips.find(c => String(c.item_id) === fDest.slice(3)) || null
    : null;
  // a RECEIVE ADDRESS picked as the destination (transfers between the
  // group's own locations — e.g. Paige PMB 1 -> Ian Home); its snapshot
  // travels in the destination jsonb like a custom address, no
  // transfer_destinations CAS
  const destReceiveAddr = fDest.startsWith('ra_')
    ? addresses.find(a => String(a.id) === fDest.slice(3)) || null
    : null;

  // appended to every recovery-path outcome whenever a linked direct-ship
  // line failed to stamp — the label saved fine, but the customer's order
  // line stayed outstanding and the operator must know on EVERY path
  const directMissNote = (fin: { directItemId: number | null; directStamped: boolean; linkReclaimed: boolean }) =>
    fin.linkReclaimed
      ? 'WARNING: this draft LOST its direct-ship reservation to a newer draft before this label was recovered — the label is saved but tied to NO order line. Check the transfer log for a duplicate label to the same customer and refund one.'
      : fin.directItemId != null && !fin.directStamped
        ? 'NOTE: the linked direct-ship order line was NOT marked (already fulfilled, its order is now held/unpaid, its quantity or address changed) — verify in the order sheet.'
        : '';

  // recovery on a RECLAIMED draft is legitimate (the label may be real
  // money) but must be a conscious act — the recovered label cannot tie
  // to any order line and may duplicate the newer draft's shipment
  const confirmReclaimedRecovery = (t: TransferRow): boolean =>
    !t.direct_link_reclaimed_at
    || window.confirm('This draft\'s direct-ship reservation was taken over by a NEWER draft, so any label recovered here is tied to NO order line and may DUPLICATE that newer shipment. Only continue to recover a label that was really purchased (it will be recorded for refund/inspection). Continue?');

  const destAddress = (): ShippoAddress | null => {
    if (fDest === '__custom__') {
      if (!custom.name || !custom.street1 || !custom.city || !custom.state || !custom.zip) return null;
      return toShippoAddress(custom);
    }
    if (fDest.startsWith('ds_')) {
      if (!directCandidate) return null;
      const c = directCandidate;
      if (!c.address_line1 || !c.city || !c.state_code || !c.postal_code) return null;
      return {
        name: c.contact_name || c.customer_name, street1: c.address_line1,
        street2: c.address_line2 || undefined as unknown as string,
        city: c.city, state: c.state_code, zip: c.postal_code, country: 'US',
        phone: c.contact_phone || undefined as unknown as string,
        email: c.contact_email || undefined as unknown as string,
      };
    }
    if (fDest.startsWith('ra_')) {
      return destReceiveAddr ? toShippoAddress(destReceiveAddr) : null;
    }
    const d = destinations.find(x => String(x.id) === fDest);
    return d ? toShippoAddress(d) : null;
  };
  const destLabel = fDest === '__custom__'
    ? (custom.name || 'custom')
    : directCandidate
      ? `Direct: ${directCandidate.customer_name} #${directCandidate.order_number}`
      : destReceiveAddr
        ? destReceiveAddr.label
        : (destinations.find(x => String(x.id) === fDest)?.label || '');

  const onHand = (productId: number) =>
    inventory
      .filter(r => groupMemberIds.has(Number(r.receive_address_id)) && r.product_id === productId)
      .reduce((s, r) => s + Number(r.on_hand_qty || 0), 0);

  // signature of every input the RATE depends on — a quote fetched for one
  // shipment must never buy a label while the form describes another. Any
  // edit to ship-from, destination, or parcel invalidates fetched rates.
  // The ship-from and saved-destination CONTENTS are in the signature too:
  // editing the address record (not just picking another) re-quotes.
  const quoteSig = JSON.stringify({
    fFrom, from: addresses.find(a => String(a.id) === fFrom) || null,
    fDest, dest: destinations.find(d => String(d.id) === fDest) || null,
    // direct-ship CONTENT too: a refreshed candidate list with a changed
    // ship-to (order re-imported with a new address) re-quotes
    direct: directCandidate,
    // receive-address destination CONTENT: editing the address record
    // re-quotes, same as saved destinations
    ra: destReceiveAddr,
    custom, dims,
  });
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
      const res = await getRates(shippoHttp, shippoKey, toShippoAddress(from), to, {
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
      // over-on-hand needs the operator's EXPLICIT confirmation, which then
      // travels with the write — the server re-checks live inventory and
      // refuses an unconfirmed overage (mis-keyed quantities can't slip
      // through, and the override lands in the audit trail)
      const overLines = lines.filter(l => Number(l.qty) > onHand(Number(l.product)));
      let allowOver = false;
      if (overLines.length > 0) {
        const detail = overLines.map(l => `${products.find(p => String(p.id) === l.product)?.sku_code || '?'}: sending ${l.qty}, only ${fmtNum(onHand(Number(l.product)))} on hand`).join('; ');
        if (!window.confirm(`This transfer sends MORE than is on hand at this address (${detail}). On-hand will go negative. Send anyway?`)) {
          setPurchaseMsg('Cancelled — nothing was purchased.');
          return;
        }
        allowOver = true;
      }
      // 1. DRAFT FIRST, ATOMIC WITH ITS ITEMS: a failed purchase leaves a
      //    visible draft with its full contents; a succeeded purchase
      //    always has a complete home to finalize into. The insert also
      //    stamps the purchase lease (blocks concurrent draft deletion).
      // the ship-from row the QUOTE was priced for — the server refuses the
      // draft if the address was edited or archived since (another session
      // can change it without this tab's props ever updating)
      const fromRow = addresses.find(a => String(a.id) === fFrom);
      if (!fromRow) { setPurchaseMsg('Ship-from address not found — reload the page.'); return; }
      // Shippo refuses purchases whose address_from has no phone
      // ("address_from.phone must not be empty") — refuse BEFORE the
      // draft exists, same guard as the fulfillment Ship dialog, so the
      // fix is one field instead of a delete-and-requote loop
      if (!String(fromRow.phone ?? '').trim()) {
        setPurchaseMsg(`"${fromRow.label}" has no phone — Shippo refuses label purchases without a ship-from phone. Add one on the Addresses tab (it goes to the carrier, not onto the label), then re-fetch rates.`);
        return;
      }
      const expectedFrom = {
        name: sN(fromRow.name), street1: sN(fromRow.street1), street2: sN(fromRow.street2),
        city: sN(fromRow.city), state: sN(fromRow.state), zip: sN(fromRow.zip),
        country: sN(fromRow.country), phone: sN(fromRow.phone), email: sN(fromRow.email),
      };
      // the SAVED destination the quote was priced for — the server refuses
      // if that row was edited or archived since; custom and direct-ship
      // destinations skip this (their snapshots live in this form / the
      // order row, and the direct LINE is separately validated in the fn)
      const isDirect = fDest.startsWith('ds_');
      const isRa = fDest.startsWith('ra_');
      const destRow = fDest !== '__custom__' && !isDirect && !isRa ? destinations.find(d => String(d.id) === fDest) : null;
      if (fDest !== '__custom__' && !isDirect && !isRa && !destRow) { setPurchaseMsg('Destination not found — reload the page.'); return; }
      if (isRa && !destReceiveAddr) { setPurchaseMsg('Destination address not found — reload the page.'); return; }
      if (isDirect && !directCandidate) { setPurchaseMsg('That direct-ship order line is no longer available (fulfilled or changed) — pick another destination.'); return; }
      const expectedDest = destRow ? {
        name: sN(destRow.name), street1: sN(destRow.street1), street2: sN(destRow.street2),
        city: sN(destRow.city), state: sN(destRow.state), zip: sN(destRow.zip),
        country: sN(destRow.country), phone: sN(destRow.phone), email: sN(destRow.email),
      } : null;
      let draftId: number | null = null;
      let claimedAt = '';
      const draftParams = (allow: boolean) => ({
        from_address_id: Number(fFrom), destination_label: destLabel,
        destination: JSON.stringify(to),
        source_package_id: selectedBoxId ? String(selectedBoxId) : '',
        parcel: JSON.stringify({ length: dims.length.trim(), width: dims.width.trim(), height: dims.height.trim(), distance_unit: 'in', weight: dims.weight.trim(), mass_unit: 'lb' }),
        carrier: rate.provider, servicelevel: rate.servicelevel?.name || rate.servicelevel?.token || '',
        rate_amount: rate.amount, rate_currency: rate.currency, shippo_rate_id: rate.object_id,
        items: JSON.stringify(lines.map(l => ({ product_id: Number(l.product), qty: l.qty.trim() }))),
        allow_over_onhand: allow,
        expected_from: JSON.stringify(expectedFrom),
        destination_id: destRow ? String(destRow.id) : '',
        expected_destination: expectedDest ? JSON.stringify(expectedDest) : '',
        // the fn re-validates this line AT WRITE TIME: outstanding,
        // money-gated, CAMPAIGN-BOUND to this buy, and its product among
        // the transfer's items
        direct_order_item_id: directCandidate ? String(directCandidate.item_id) : '',
        group_buy_id: groupBuyId ?? '',
        note: fNote.trim(), actor: userName,
      });
      try {
        let res = await doCreate(draftParams(allowOver)) as unknown[] | null;
        // the server ALSO subtracts unfinalized-draft RESERVATIONS this
        // page's on-hand numbers can't see — a refusal with no override yet
        // gets the same explicit confirm-and-retry the visible overage does,
        // so reserved stock never dead-ends a legitimate transfer
        if (!(Array.isArray(res) && res.length > 0) && !allowOver) {
          if (!window.confirm('The server reports less available stock than this page shows — other unfinished transfer drafts may be reserving some of it. Send anyway? On-hand can go negative if those drafts complete.')) {
            setPurchaseMsg('Cancelled — nothing was purchased.');
            return;
          }
          res = await doCreate(draftParams(true)) as unknown[] | null;
        }
        const row = Array.isArray(res) && res.length > 0 ? res[0] as { id: string; claimed_at?: string } : null;
        draftId = row ? Number(row.id) : null;
        claimedAt = row?.claimed_at || '';
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : '';
        setPurchaseMsg(m.includes('transfers_rate_unique')
          ? 'This exact rate was already purchased (double-click?) — check the transfer log before buying again.'
          : m.includes('transfers_direct_item_active_uniq')
            ? 'Another unfinished transfer already reserves this direct-ship order line (possibly the other admin, just now) — check the drafts below before trying again.'
            : (m || 'Failed to save the transfer draft.') + ' Nothing was saved or purchased.');
        return;
      }
      if (!draftId) { setPurchaseMsg('Draft not saved — nothing was purchased. Possible causes: a line exceeds on-hand (retry to re-confirm), the ship-from address was edited or archived since rates were fetched, or the direct-ship order line is no longer eligible (fulfilled meanwhile, order held, payment pending, its SHIP-TO ADDRESS was corrected since the quote, or this transfer carries LESS than the ordered quantity of their product) — reload and re-quote.'); return; }
      // 2. HEARTBEAT immediately before money moves: if this tab slept
      //    long enough for the birth lease to age out and another session
      //    deleted or re-claimed the draft, the own-token refresh returns
      //    zero rows and we abort with NO Shippo POST
      if (claimedAt) {
        const hb = await doClaimPurchase({ transfer_id: draftId, prior_claimed_at: claimedAt, actor: userName }) as unknown[] | null;
        const hbRow = Array.isArray(hb) && hb.length > 0 ? hb[0] as { claimed_at?: string } : null;
        if (!hbRow) {
          setPurchaseMsg('Not purchased — this draft was deleted or claimed by another session while this page was idle, or (for a direct-ship destination) the customer\'s ship-to address changed since the quote. Reload and re-quote; nothing was charged.');
          reloadTransfers();
          return;
        }
        claimedAt = hbRow.claimed_at || claimedAt;
      }
      // 3. buy the label (single attempt inside)
      let result: PurchaseResult;
      try {
        result = await purchaseLabel(shippoHttp, shippoKey, rate.object_id);
      } catch (e: unknown) {
        // a DEFINITIVE Shippo refusal (no charge, no label) releases the
        // lease so the draft is immediately retryable/deletable; ambiguous
        // failures keep it — money may have moved. CAS: only THIS claim is
        // released, never a newer session's re-claim.
        if (e instanceof ShippoPurchaseRefusedError && claimedAt) {
          await doClearLease({ transfer_id: draftId, claimed_at: claimedAt, actor: userName }).catch(() => null);
        }
        setPurchaseMsg((e instanceof Error ? e.message : 'Purchase failed') + ' — the draft is saved below; retry or delete it there.');
        reloadTransfers();
        return;
      }
      // 4. persist — retryable from memory if this write fails or THROWS
      const fin = await persistFinalize(draftId, result, rate.object_id);
      if (!fin.ok) {
        setPendingFinalize(m => ({ ...m, [draftId!]: result }));
        setPurchaseMsg(`LABEL PURCHASED (transaction ${result.transactionId}) but saving failed — label: ${result.labelUrl} — use "Retry save" on the draft below; do NOT purchase again.`);
        reloadTransfers();
        return;
      }
      setSuccess(result);
      setSuccessDirect(fin.directItemId != null
        ? (fin.directStamped
          ? `Order ${directCandidate ? '#' + directCandidate.order_number + ' (' + directCandidate.customer_name + ')' : ''} marked direct-shipped — the tracking number is now on the customer's order line.`
          : 'NOTE: the linked direct-ship order line was NOT marked (already fulfilled, or its order is now held/unpaid) — verify in the order sheet before shipping.')
        : '');
      setRatesResult(null); setPickedRate(''); setFLines([{ product: '', qty: '' }]); setFNote('');
      setSelectedBoxId(null);
      if (fDest.startsWith('ds_')) setFDest('');
      reloadTransfers();
    } finally {
      purchaseInFlight.current = false;
      setPurchasing(false);
    }
  };

  // record a transfer whose label was bought OUTSIDE the app: no rates,
  // no lease, no Shippo POST — the DB function applies the same guards
  // as the draft path and stamps a linked direct line ATOMICALLY (any
  // gate failure refuses the whole record; nothing was charged, so
  // refusing outright is free — no direct_stamped=0 halfway state here)
  const recordManual = async () => {
    if (manualInFlight.current) return;   // synchronous double-click guard
    setPurchaseMsg(''); setManualSuccess(''); setSuccessDirect('');
    const from = addresses.find(a => String(a.id) === fFrom);
    if (!from) { setPurchaseMsg('Pick the ship-from receive address.'); return; }
    const to = destAddress();
    if (!to) { setPurchaseMsg('Destination incomplete — name, street, city, state, and zip are required.'); return; }
    const isDirect = fDest.startsWith('ds_');
    if (isDirect && !directCandidate) { setPurchaseMsg('That direct-ship order line is no longer available — pick another destination.'); return; }
    const carrier = (mCarrier === '__other__' ? mCarrierOther : mCarrier).trim().toLowerCase();
    if (!carrier) { setPurchaseMsg('Pick or enter the carrier.'); return; }
    if (!mTracking.trim()) { setPurchaseMsg('Enter the tracking number from the label.'); return; }
    if (mCost.trim() && (!/^\d+(?:\.\d{1,2})?$/.test(mCost.trim()) || !(Number(mCost) > 0))) {
      setPurchaseMsg('Cost must be a positive amount with at most 2 decimals (or leave it blank).');
      return;
    }
    const { lines, error: lineError } = validateLines();
    if (lineError) { setPurchaseMsg(lineError); return; }
    const overLines = lines.filter(l => Number(l.qty) > onHand(Number(l.product)));
    let allowOver = false;
    if (overLines.length > 0) {
      const detail = overLines.map(l => `${products.find(p => String(p.id) === l.product)?.sku_code || '?'}: sending ${l.qty}, only ${fmtNum(onHand(Number(l.product)))} on hand`).join('; ');
      if (!window.confirm(`This transfer sends MORE than is on hand at this address (${detail}). On-hand will go negative. Record anyway?`)) {
        setPurchaseMsg('Cancelled — nothing was recorded.');
        return;
      }
      allowOver = true;
    }
    const isRa = fDest.startsWith('ra_');
    const destRow = fDest !== '__custom__' && !isDirect && !isRa ? destinations.find(d => String(d.id) === fDest) : null;
    if (fDest !== '__custom__' && !isDirect && !isRa && !destRow) { setPurchaseMsg('Destination not found — reload the page.'); return; }
    if (isRa && !destReceiveAddr) { setPurchaseMsg('Destination address not found — reload the page.'); return; }
    const expectedFrom = {
      name: sN(from.name), street1: sN(from.street1), street2: sN(from.street2),
      city: sN(from.city), state: sN(from.state), zip: sN(from.zip),
      country: sN(from.country), phone: sN(from.phone), email: sN(from.email),
    };
    const expectedDest = destRow ? {
      name: sN(destRow.name), street1: sN(destRow.street1), street2: sN(destRow.street2),
      city: sN(destRow.city), state: sN(destRow.state), zip: sN(destRow.zip),
      country: sN(destRow.country), phone: sN(destRow.phone), email: sN(destRow.email),
    } : null;
    const params = (allow: boolean) => ({
      from_address_id: Number(fFrom), destination_label: destLabel,
      destination: JSON.stringify(to),
      source_package_id: selectedBoxId ? String(selectedBoxId) : '',
      carrier, tracking_number: mTracking.trim(), cost: mCost.trim(),
      items: JSON.stringify(lines.map(l => ({ product_id: Number(l.product), qty: l.qty.trim() }))),
      allow_over_onhand: allow,
      expected_from: JSON.stringify(expectedFrom),
      destination_id: destRow ? String(destRow.id) : '',
      expected_destination: expectedDest ? JSON.stringify(expectedDest) : '',
      direct_order_item_id: directCandidate ? String(directCandidate.item_id) : '',
      group_buy_id: groupBuyId ?? '',
      note: fNote.trim(), actor: userName,
    });
    manualInFlight.current = true;
    setManualBusy(true);
    try {
      let res = await doCreateManual(params(allowOver)) as unknown[] | null;
      // same reserved-stock retry as the purchase path: the server also
      // subtracts unfinalized-draft reservations this page can't see
      if (!(Array.isArray(res) && res.length > 0) && !allowOver) {
        if (!window.confirm('The server reports less available stock than this page shows — other unfinished transfer drafts may be reserving some of it. Record anyway? On-hand can go negative if those drafts complete.')) {
          setPurchaseMsg('Cancelled — nothing was recorded.');
          return;
        }
        res = await doCreateManual(params(true)) as unknown[] | null;
      }
      if (!(Array.isArray(res) && res.length > 0)) {
        setPurchaseMsg('Not recorded. Possible causes: this tracking number is ALREADY on a finalized transfer (bought through the app or recorded manually — check the log), a line exceeds on-hand (retry to re-confirm), the ship-from address was edited or archived, or the direct-ship order line is no longer eligible (fulfilled meanwhile, order held, payment pending, ship-to changed, this transfer carries LESS than the ordered quantity, or an UNFINISHED DRAFT still reserves that line — delete it first).');
        return;
      }
      setManualSuccess(mTracking.trim().toUpperCase());
      setSuccessDirect(directCandidate
        ? `Order #${directCandidate.order_number} (${directCandidate.customer_name}) marked direct-shipped — the tracking number is now on the customer's order line.`
        : '');
      setFLines([{ product: '', qty: '' }]); setFNote(''); setMTracking(''); setMCost('');
      setSelectedBoxId(null);
      if (isDirect) { setFDest(''); reloadDirectShips(); }
      reloadTransfers();
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : '';
      // 23505 on the manual-label unique index = this label is ALREADY
      // recorded (a double-click, or a retry whose first attempt landed
      // despite an error) — definitive, safe outcome
      setPurchaseMsg(m.includes('transfers_manual_tracking_uniq')
        ? 'A manual transfer with this carrier + tracking number is ALREADY recorded — a double-click or an earlier attempt landed. Check the transfer log; nothing was duplicated.'
        // any other throw is AMBIGUOUS for a born-finalized write: the
        // insert may have committed before the error reached this tab —
        // never promise "nothing was recorded"
        : (m || 'Failed to record the transfer') + ' — this may or may not have been saved. CHECK THE TRANSFER LOG for this tracking number before retrying (a retry of a landed record is refused as a duplicate, so retrying is safe).');
      reloadTransfers();
    } finally {
      manualInFlight.current = false;
      setManualBusy(false);
    }
  };

  const retryFinalize = async (t: TransferRow) => {
    const pending = pendingFinalize[t.id];
    if (!pending) return;
    const fin = await persistFinalize(t.id, pending, t.shippo_rate_id || '');
    if (fin.ok) {
      setPendingFinalize(m => { const n = { ...m }; delete n[t.id]; return n; });
      setDraftMsg(m => ({ ...m, [t.id]: directMissNote(fin) }));
      reloadTransfers();
    } else setDraftMsg(m => ({ ...m, [t.id]: 'Save failed again — the label URL is preserved here; keep retrying.' }));
  };

  const recoverByTxn = async (t: TransferRow) => {
    const txn = (recoverTxn[t.id] || '').trim();
    if (!txn) { setDraftMsg(m => ({ ...m, [t.id]: 'Paste the transaction id from the error message or the Shippo dashboard.' })); return; }
    if (!confirmReclaimedRecovery(t)) return;
    try {
      const result = await getTransaction(shippoHttp, shippoKey, txn);
      // RATE-BOUND: a pasted id can be any label in the account — attaching
      // one bought against a different rate would finalize the WRONG draft
      // and decrement the wrong inventory. The draft's stored rate is the
      // proof of ownership.
      if (!t.shippo_rate_id || result.rateId !== t.shippo_rate_id) {
        setDraftMsg(m => ({ ...m, [t.id]: `That transaction was purchased against a different rate than this draft (transaction rate ${result.rateId || 'unknown'}, draft rate ${t.shippo_rate_id || 'missing'}) — refusing to attach it. Find the right transaction in the Shippo dashboard.` }));
        return;
      }
      const fin = await persistFinalize(t.id, result, result.rateId || '');
      if (fin.ok) { setDraftMsg(m => ({ ...m, [t.id]: directMissNote(fin) })); reloadTransfers(); }
      else setDraftMsg(m => ({ ...m, [t.id]: 'Transaction found but saving failed — retry.' }));
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Recovery failed' }));
    }
  };

  const retryPurchase = async (t: TransferRow) => {
    if (purchaseInFlight.current || !t.shippo_rate_id) return;
    if (!confirmReclaimedRecovery(t)) return;
    purchaseInFlight.current = true;
    try {
      // RELOAD-SAFE: ask Shippo whether this rate was already bought before
      // any re-purchase — a label paid for in a lost browser session is
      // recovered here instead of being bought twice
      let existing: Awaited<ReturnType<typeof findTransactionByRate>>;
      try {
        existing = await findTransactionByRate(shippoHttp, shippoKey, t.shippo_rate_id, t.created_at);
      } catch (e: unknown) {
        setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Could not verify with Shippo — not purchasing.' }));
        return;
      }
      if (existing) {
        const fin0 = await persistFinalize(t.id, existing, t.shippo_rate_id);
        if (fin0.ok) { setDraftMsg(m => ({ ...m, [t.id]: directMissNote(fin0) })); reloadTransfers(); }
        else setDraftMsg(m => ({ ...m, [t.id]: `An existing label was found (${existing.transactionId}) but saving failed — retry.` }));
        return;
      }
      // Shippo just PROVED no label exists — downgrade any stale 30-day
      // "attempted" reservation to the short window (a pre-dispatch client
      // failure must not hold stock for a month once verified). CAS on the
      // OBSERVED attempt: a newer session's fresh claim refuses this clear.
      if (t.purchase_attempted_at) {
        await doClearAttempt({ transfer_id: t.id, observed_attempted_at: t.purchase_attempted_at, actor: userName }).catch(() => null);
      }
      if (!window.confirm('No existing label found at Shippo for this rate. Buy it now? Note: rates expire after ~7 days.')) return;
      // claim the EXCLUSIVE purchase lease BEFORE money moves: zero rows
      // means the draft is gone (deleted/finalized elsewhere) OR another
      // fresh purchase attempt holds the lease — either way, abort with no
      // money spent; two admins racing this end with ONE Shippo POST
      const claim = await doClaimPurchase({ transfer_id: t.id, prior_claimed_at: '', actor: userName }) as unknown[] | null;
      const claimRow = Array.isArray(claim) && claim.length > 0 ? claim[0] as { id: string; claimed_at?: string } : null;
      if (!claimRow) {
        setDraftMsg(m => ({ ...m, [t.id]: 'Not purchased — this draft no longer exists, another purchase attempt (this draft\'s original try, or the other admin) is still fresh (<10 min), this draft\'s direct-ship reservation expired and was taken over by a NEWER draft (buying here would duplicate that shipment — delete this draft instead), or the customer\'s ship-to address changed since this draft was quoted (delete and re-quote). An explicit Shippo refusal frees a fresh lease immediately; otherwise wait a few minutes and use "Check Shippo & retry" again.' }));
        reloadTransfers();
        return;
      }
      let result: PurchaseResult;
      try {
        result = await purchaseLabel(shippoHttp, shippoKey, t.shippo_rate_id);
      } catch (e: unknown) {
        if (e instanceof ShippoPurchaseRefusedError && claimRow.claimed_at) {
          await doClearLease({ transfer_id: t.id, claimed_at: claimRow.claimed_at, actor: userName }).catch(() => null);
        }
        throw e;
      }
      const fin = await persistFinalize(t.id, result, t.shippo_rate_id);
      if (fin.ok) { setDraftMsg(m => ({ ...m, [t.id]: directMissNote(fin) })); reloadTransfers(); }
      else {
        setPendingFinalize(m => ({ ...m, [t.id]: result }));
        setDraftMsg(m => ({ ...m, [t.id]: `Label purchased (${result.transactionId}) but saving failed — ${result.labelUrl} — use Retry save.` }));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Purchase failed';
      // an address_from refusal is baked into the RATE (frozen at quote
      // time) — fixing the address cannot fix this draft's rate
      setDraftMsg(m => ({
        ...m,
        [t.id]: msg + (e instanceof ShippoPurchaseRefusedError && /address_from/i.test(msg)
          ? ' This draft\'s rate is frozen with the ship-from as it was quoted — fixing the address does NOT fix the rate. Delete this draft (Delete verifies no label first) and re-quote.'
          : ''),
      }));
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
      const existing = await findTransactionByRate(shippoHttp, shippoKey, t.shippo_rate_id, t.created_at);
      if (existing) {
        const fin = await persistFinalize(t.id, existing, t.shippo_rate_id);
        setDraftMsg(m => ({ ...m, [t.id]: fin.ok
          ? directMissNote(fin)
          : `A PURCHASED label exists for this draft (${existing.transactionId}) — recovered instead of deleting, but saving failed — retry.` }));
        reloadTransfers();
        return;
      }
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Could not verify with Shippo — not deleting.' }));
      return;
    }
    // verified no-label: downgrade any stale attempted-reservation even if
    // the operator cancels the delete confirm below (CAS on the observed
    // attempt — a newer session's fresh claim refuses this clear)
    if (t.purchase_attempted_at) {
      await doClearAttempt({ transfer_id: t.id, observed_attempted_at: t.purchase_attempted_at, actor: userName }).catch(() => null);
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
    if (refundInFlight.current) return;   // synchronous double-click guard
    // no key = no request could possibly reach Shippo — refuse BEFORE the
    // REQUESTING marker, or the row would durably look refund-in-flight
    // when nothing was ever sent
    if (!shippoKey) {
      setDraftMsg(m => ({ ...m, [t.id]: 'No Shippo API token is set (Settings) — the refund request cannot be sent.' }));
      return;
    }
    if (!window.confirm(`Request a refund for this label (${fmtUSD(t.rate_amount)})? Carrier refunds settle over days and only succeed for UNUSED labels. The transfer stays in the log; its items count as transferred until "Re-check" records a SUCCESS refund — at that point the shipment provably never moved and the items return to on-hand automatically.`)) return;
    refundInFlight.current = true;
    try {
      // persist the intent BEFORE the POST — a one-way compare-and-set
      // ('REQUESTING' only lands on a row with no status), so a concurrent
      // admin's click loses here with zero rows and NEVER reaches Shippo;
      // a browser death after this leaves durable REQUESTING evidence
      const mark = await doSetRefund({ transfer_id: t.id, refund_status: 'REQUESTING', prior_requested_at: '', actor: userName }) as unknown[] | null;
      const markRow = Array.isArray(mark) && mark.length > 0 ? mark[0] as { requested_at?: string } : null;
      if (!markRow) {
        setDraftMsg(m => ({ ...m, [t.id]: 'Not sent — a refund for this label was already requested (possibly by the other admin just now). Use "Re-check" to see its status.' }));
        reloadTransfers();
        return;
      }
      reloadTransfers();
      // HEARTBEAT immediately before the POST: if this tab slept past the
      // marker's freshness window and another session cleared or
      // re-requested, the own-token re-stamp returns zero rows — abort
      // with NO Shippo POST
      if (markRow.requested_at) {
        const hb = await doSetRefund({ transfer_id: t.id, refund_status: 'REQUESTING', prior_requested_at: markRow.requested_at, actor: userName }) as unknown[] | null;
        if (!(Array.isArray(hb) && hb.length > 0)) {
          setDraftMsg(m => ({ ...m, [t.id]: 'Not sent — this request marker was cleared or superseded while the page was idle. Use "Re-check" before requesting again.' }));
          reloadTransfers();
          return;
        }
      }
      try {
        const status = await requestRefund(shippoHttp, shippoKey, t.shippo_transaction_id);
        await doSetRefund({ transfer_id: t.id, refund_status: status, prior_requested_at: '', actor: userName });
        reloadTransfers();
      } catch (e: unknown) {
        setDraftMsg(m => ({ ...m, [t.id]: (e instanceof Error ? e.message : 'Refund request failed') + ' The row stays marked REQUESTING — use "Re-check" to reconcile with Shippo; do not assume it failed.' }));
      }
    } finally {
      refundInFlight.current = false;
    }
  };

  // reconcile a stuck/uncertain refund with Shippo: an exhaustive listing
  // either finds the refund (record its real status) or proves none exists
  // (clear the marker so the button returns)
  const recheckRefund = async (t: TransferRow) => {
    if (!t.shippo_transaction_id) return;
    if (refundInFlight.current) return;
    if (!shippoKey) {
      setDraftMsg(m => ({ ...m, [t.id]: 'No Shippo API token is set (Settings) — cannot check the refund status.' }));
      return;
    }
    refundInFlight.current = true;
    try {
      const status = await findRefundByTransaction(shippoHttp, shippoKey, t.shippo_transaction_id, t.created_at);
      if (status) {
        await doSetRefund({ transfer_id: t.id, refund_status: status, prior_requested_at: '', actor: userName });
        setDraftMsg(m => ({ ...m, [t.id]: '' }));
      } else {
        // a null listing is NOT auto-cleared: the operator confirms
        // explicitly (a lagging listing or a lost-response POST could
        // otherwise reopen the button and double-request), and the action
        // still refuses any clear while the marker is under 10 minutes old
        if (!window.confirm('Shippo\'s FULL refund listing shows no refund for this label. Clear the marker so a refund can be requested again? Only confirm if you\'re confident the original request never reached Shippo — a duplicate request cannot be undone.')) {
          setDraftMsg(m => ({ ...m, [t.id]: 'Marker kept — Re-check again later; Shippo listings can lag a lost-response request.' }));
          return;
        }
        const cleared = await doSetRefund({ transfer_id: t.id, refund_status: '', prior_requested_at: '', actor: userName }) as unknown[] | null;
        setDraftMsg(m => ({ ...m, [t.id]: (Array.isArray(cleared) && cleared.length > 0)
          ? 'Marker cleared — Shippo holds no refund for this label; you can request again.'
          : 'Not cleared — the request marker is under 10 minutes old; a request may still be in flight (possibly the other admin\'s). Re-check again in a few minutes.' }));
      }
      reloadTransfers();
    } catch (e: unknown) {
      setDraftMsg(m => ({ ...m, [t.id]: e instanceof Error ? e.message : 'Refund check failed' }));
    } finally {
      refundInFlight.current = false;
    }
  };

  const drafts = transfers.filter(t => !t.finalized_at);
  const finalized = transfers.filter(t => !!t.finalized_at);
  const labelSpendTotal = finalized.reduce((s, t) => s + Number(t.rate_amount || 0), 0);

  // received boxes still at the selected ship-from address — clickable
  // form-fillers: one click loads a box's contents into the item lines
  // boxes already sent out (a finalized, non-voided transfer records
  // them as its source) leave the picker — a parted-out package must
  // not look available to transfer again; a refund SUCCESS voids the
  // transfer and the box returns
  const consumedPkgIds = React.useMemo(() => new Set(
    transfers
      .filter(t => t.finalized_at && t.refund_status !== 'SUCCESS' && t.source_package_id != null)
      .map(t => Number(t.source_package_id))), [transfers]);
  const boxesAtFrom = packages.filter(p =>
    groupMemberIds.has(Number(p.receive_address_id)) && p.received_at
    && (p.items || []).length > 0 && !consumedPkgIds.has(Number(p.id)));
  // direct-ship destinations are offered only when the transfer actually
  // carries the customer's product (the fn re-checks this at write time)
  const lineProductIds = new Set(fLines.filter(l => l.product).map(l => Number(l.product)));
  const directOptions = directShips.filter(c => lineProductIds.has(Number(c.product_id)));

  // a picked direct-ship destination whose line vanished (fulfilled by
  // another session, product removed from the lines, campaign reload)
  // resets to unselected instead of silently quoting a dead target
  React.useEffect(() => {
    if (fDest.startsWith('ds_') && (!directCandidate || !lineProductIds.has(Number(directCandidate.product_id)))) setFDest('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fDest, directCandidate, JSON.stringify([...lineProductIds])]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">New transfer — buy a label via Shippo</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Select value={fFrom} onValueChange={v => { setFFrom(v); setSelectedBoxId(null); }}>
              <SelectTrigger className="h-9 flex-1 min-w-40"><SelectValue placeholder="Ship from (receive address)" /></SelectTrigger>
              <SelectContent>
                {addresses.filter(a => a.active && a.transfer_origin_id == null).map(a => {
                  const members = addresses.filter(m => Number(m.transfer_origin_id ?? 0) === Number(a.id)).length;
                  return <SelectItem key={a.id} value={String(a.id)}>{a.label}{members > 0 ? ` (+${members} grouped)` : ''}</SelectItem>;
                })}
              </SelectContent>
            </Select>
            <Select value={fDest} onValueChange={setFDest}>
              <SelectTrigger className="h-9 flex-1 min-w-40"><SelectValue placeholder="Destination" /></SelectTrigger>
              <SelectContent>
                {/* receive addresses as transfer-to targets — the two
                    everyday ones pinned first (Ian), then the rest, then
                    saved destinations; the exact FROM address is excluded */}
                {(() => {
                  const PINNED = ['Paige PMB 1', 'Ian Home'];
                  const opts = addresses.filter(a => a.active && String(a.id) !== fFrom);
                  const ordered = [
                    ...PINNED.map(l => opts.find(a => a.label === l)).filter((a): a is typeof opts[number] => !!a),
                    ...opts.filter(a => !PINNED.includes(a.label)).sort((a, b) => a.label.localeCompare(b.label)),
                  ];
                  return ordered.map(a => (
                    <SelectItem key={`ra_${a.id}`} value={`ra_${a.id}`}>{a.label}</SelectItem>
                  ));
                })()}
                {destinations.filter(d => d.active).map(d => <SelectItem key={d.id} value={String(d.id)}>{d.label}</SelectItem>)}
                <SelectItem value="__custom__">Custom address…</SelectItem>
                {directOptions.map(c => (
                  <SelectItem key={`ds_${c.item_id}`} value={`ds_${c.item_id}`}>
                    Direct: {c.customer_name} #{c.order_number} — {c.sku_code} × {fmtNum(c.qty)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {fFrom && boxesAtFrom.length > 0 && (
            <div className="space-y-1">
              <p className="text-[11px] text-muted-foreground">
                Boxes received at this address — click one to load its contents into the transfer (lines stay editable):
              </p>
              <div className="flex flex-wrap gap-2">
                {boxesAtFrom.map(b => {
                  const sel = selectedBoxId === b.id;
                  return (
                    <button key={b.id} type="button"
                      onClick={() => {
                        setSelectedBoxId(b.id);
                        setFLines((b.items || []).map(i => ({ product: String(i.product_id), qty: String(i.qty) })));
                      }}
                      className={`rounded-lg border p-2 text-left text-xs space-y-1 max-w-full ${sel ? 'border-violet-500 ring-1 ring-violet-500 bg-violet-50' : 'hover:bg-muted/50'}`}>
                      <div className="font-mono text-[10px] text-muted-foreground break-all">
                        {b.carrier.toUpperCase()} · {b.tracking_number}{b.vendor_code ? ` · ${b.vendor_code}` : ''}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {(b.items || []).map(i => (
                          <span key={i.product_id} className={`rounded text-[10px] font-semibold px-1.5 py-0.5 ${productChipClass(i.product_id)}`}>
                            {i.name || i.sku_code} × {fmtNum(i.qty)}
                          </span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {directShipsOverflow && (
            <p className="text-[11px] text-amber-700">
              More than 1,000 eligible direct-ship lines exist in this buy — the destination list shows the first 1,000 by order number. A line you expect but don't see may be past the window; ship it from its order in Fulfillment or narrow the campaign's outstanding list first.
            </p>
          )}
          {directCandidate && (
            <p className="text-[11px] text-muted-foreground">
              Ships to {directCandidate.contact_name || directCandidate.customer_name}, {directCandidate.address_line1}
              {directCandidate.address_line2 ? `, ${directCandidate.address_line2}` : ''}, {directCandidate.city}, {directCandidate.state_code} {directCandidate.postal_code}
              {' '}— this customer ordered <span className="font-medium">{directCandidate.sku_code} × {fmtNum(directCandidate.qty)}</span>; buying the label marks that order line direct-shipped with this tracking number. The transfer must carry at least that quantity of {directCandidate.sku_code} (more is fine — under-ships won't link).
            </p>
          )}
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
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input type="checkbox" checked={manualMode} onChange={e => { setManualMode(e.target.checked); setPurchaseMsg(''); setManualSuccess(''); setRatesResult(null); setPickedRate(''); }} />
            <span>Label bought <span className="font-medium">outside the app</span> — enter the tracking number manually (no rate shopping, no Shippo purchase)</span>
          </label>
          {manualMode ? (
            <div className="flex flex-wrap gap-2">
              <Select value={mCarrier} onValueChange={setMCarrier}>
                <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Carrier" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="usps">USPS</SelectItem>
                  <SelectItem value="ups">UPS</SelectItem>
                  <SelectItem value="fedex">FedEx</SelectItem>
                  <SelectItem value="dhl_express">DHL Express</SelectItem>
                  <SelectItem value="dhl_ecommerce">DHL eCommerce</SelectItem>
                  <SelectItem value="canada_post">Canada Post</SelectItem>
                  <SelectItem value="__other__">Other…</SelectItem>
                </SelectContent>
              </Select>
              {mCarrier === '__other__' && (
                <Input placeholder="Carrier token" value={mCarrierOther} onChange={e => setMCarrierOther(e.target.value)} className="h-9 w-36" />
              )}
              <Input placeholder="Tracking number" value={mTracking} onChange={e => setMTracking(e.target.value)} className="h-9 flex-1 min-w-52 font-mono" />
              <Input placeholder="Cost $ (optional)" value={mCost} onChange={e => setMCost(e.target.value)} className="h-9 w-32" />
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Input placeholder="Length (in)" value={dims.length} onChange={e => setDims(d => ({ ...d, length: e.target.value }))} className="h-9" />
              <Input placeholder="Width (in)" value={dims.width} onChange={e => setDims(d => ({ ...d, width: e.target.value }))} className="h-9" />
              <Input placeholder="Height (in)" value={dims.height} onChange={e => setDims(d => ({ ...d, height: e.target.value }))} className="h-9" />
              <Input placeholder="Weight (lb)" value={dims.weight} onChange={e => setDims(d => ({ ...d, weight: e.target.value }))} className="h-9" />
            </div>
          )}
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
                    {over ? `only ${fmtNum(oh ?? 0)} on hand — sending more asks for confirmation at purchase` : `${fmtNum(oh ?? 0)} on hand`}
                  </span>
                )}
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2 items-center">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setFLines(ls => [...ls, { product: '', qty: '' }])}>+ Add product</Button>
            <Input placeholder="Note (optional)" value={fNote} onChange={e => setFNote(e.target.value)} className="h-8 flex-1 min-w-40" />
            {manualMode
              ? <Button size="sm" className="h-8" onClick={recordManual} disabled={manualBusy}>{manualBusy ? 'Recording…' : 'Record transfer'}</Button>
              : <Button size="sm" className="h-8" onClick={fetchRates} disabled={ratesLoading}>{ratesLoading ? 'Fetching rates…' : 'Get rates (UPS / USPS)'}</Button>}
          </div>
          {fMsg && <p className="text-xs text-red-600">{fMsg}</p>}

          {!manualMode && ratesResult && (
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
          {manualSuccess && (
            <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900 space-y-1">
              <p className="font-semibold">Transfer recorded (manual label).</p>
              <p className="text-xs">Tracking: <span className="font-mono">{manualSuccess}</span> — inventory moved; no label PDF (bought outside the app), no refund flow.</p>
              {successDirect && (
                <p className="text-xs">{successDirect}</p>
              )}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setManualSuccess(''); setSuccessDirect(''); }}>Done</Button>
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
              {successDirect && (
                <p className={`text-xs ${successDirect.startsWith('NOTE:') ? 'text-amber-800 font-medium' : ''}`}>{successDirect}</p>
              )}
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setSuccess(null); setSuccessDirect(''); }}>Done</Button>
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
                {t.direct_link_reclaimed_at && (
                  <p className="text-[11px] text-amber-700 font-medium">
                    Direct-ship reservation moved to a NEWER draft — buying here is blocked; recover an already-purchased label (it will be tied to no order line) or delete this draft.
                  </p>
                )}
                {!t.direct_link_reclaimed_at && t.direct_order_item_id != null && t.purchase_attempted_at && (
                  <p className="text-[11px] text-amber-700">
                    This unfinished draft is HOLDING its customer's direct-ship line (a purchase was attempted — a label may exist at Shippo). "Check Shippo & retry" verifies: it recovers a real label, or proves none exists and releases the hold early.
                  </p>
                )}
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
                    <TableCell className="text-xs whitespace-nowrap">
                      {t.carrier} {t.servicelevel}
                      {!t.shippo_rate_id && (
                        <span className="ml-1 rounded bg-gray-100 text-gray-700 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title="Label bought outside the app — tracking entered manually">manual</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{fmtUSD(t.rate_amount)}</TableCell>
                    <TableCell className="text-xs font-mono break-all max-w-40">{t.tracking_number || '—'}</TableCell>
                    <TableCell>
                      {t.label_url && <a href={t.label_url} target="_blank" rel="noreferrer" className="text-xs underline whitespace-nowrap" title="Public unauthenticated link — don't share">Label PDF</a>}
                    </TableCell>
                    <TableCell>
                      {!t.shippo_transaction_id
                        ? <span className="text-[11px] text-muted-foreground whitespace-nowrap" title="This label was not bought through Shippo here — refund it wherever it was purchased">no in-app refund</span>
                        : t.refund_status
                          ? <span className="inline-flex items-center gap-1">
                              <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap" title="Re-check records the final outcome — a SUCCESS refund returns the items to on-hand (the label was never used)">refund {t.refund_status}</span>
                              <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" title="Ask Shippo for this refund's real status — records it, or clears the marker if no refund exists" onClick={() => recheckRefund(t)}>Re-check</Button>
                            </span>
                          : shippoKey
                            ? <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={() => refund(t)}>Request refund</Button>
                            : <span className="text-[11px] text-muted-foreground whitespace-nowrap" title="Add the Shippo API token in Settings to request refunds">refund needs key</span>}
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
