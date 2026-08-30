import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getPackableItems from '@/actions/fulfillment/getPackableItems';
import listOrderShipments from '@/actions/fulfillment/listOrderShipments';
import createShipmentDraft from '@/actions/fulfillment/createShipmentDraft';
import recordManualShipment from '@/actions/fulfillment/recordManualShipment';
import markShipmentPurchaseStarted from '@/actions/fulfillment/markShipmentPurchaseStarted';
import clearShipmentPurchaseLease from '@/actions/fulfillment/clearShipmentPurchaseLease';
import clearShipmentAttemptVerified from '@/actions/fulfillment/clearShipmentAttemptVerified';
import finalizeShipment from '@/actions/fulfillment/finalizeShipment';
import deleteShipmentDraft from '@/actions/fulfillment/deleteShipmentDraft';
import setShipmentRefund from '@/actions/fulfillment/setShipmentRefund';
import markShipmentPushed from '@/actions/fulfillment/markShipmentPushed';
import addShipmentPhoto from '@/actions/fulfillment/addShipmentPhoto';
import listShipmentPhotos from '@/actions/fulfillment/listShipmentPhotos';
import getShipmentPhoto from '@/actions/fulfillment/getShipmentPhoto';
import deleteShipmentPhoto from '@/actions/fulfillment/deleteShipmentPhoto';
import appendOrderAdminNote from '@/actions/orders/appendOrderAdminNote';
import { compressImageToDataUrl } from '@/lib/imageCapture';
import type { CapturedPhoto } from '@/lib/imageCapture';
import { newStashKey, readStash, stashUpsert, stashRemove } from '@/lib/photoStash';
import type { StashedPhoto } from '@/lib/photoStash';
import { getRates, purchaseLabel, getTransaction, findTransactionByRate, requestRefund, findRefundByTransaction, ShippoPurchaseRefusedError } from '@/lib/shippo';
import type { ShippoAddress, ShippoRate, PurchaseResult } from '@/lib/shippo';
import type { ShippoHttp } from '@/lib/useShippoHttp';
import { pushShipmentUpstream } from '@/lib/pushShipment';
import type { PushPackableLine } from '@/lib/pushShipment';
import type { B44Config } from '@/lib/base44';
import { fmtUSD, fmtNum, fmtDateTime } from '@/lib/fmt';
import { rows } from '@/lib/rows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { StatusPill } from '@/components/StatusPill';
import type { RxAddress } from '@/app/pages/receiving/shared';

/*
 * The shipping modal: quote + buy a Shippo label (or record a manual one)
 * for ONE box of an order, with per-line quantity attribution (FULL when
 * every input keeps its default remaining; PARTIAL otherwise). The
 * money-safe purchase spine is the transfers one: draft-first (rate id
 * stored BEFORE the POST), heartbeat lease CAS, single purchaseLabel,
 * retryable finalize, pendingFinalize + proof-walk recovery. After a
 * shipment lands, the Base44 push runs automatically and its outcome is
 * shown with a Retry — a failed push never blocks or rolls back the
 * local shipment.
 */

type PackableLine = {
  order_item_id: number; product_id: number; sku_code: string; product_name: string;
  product_external_id: string | null; unit_weight_oz: string | null; digital: boolean;
  effective_qty: string; attributed_qty: string; shipped_qty: string; remaining_qty: string;
  direct_ship: boolean; direct_fulfilled_at: string | null;
};
type ShipmentRow = {
  id: number; order_id: number; status: string; carrier: string | null; servicelevel: string | null;
  tracking_number: string | null; label_cost_usd: string; rate_amount: string | null; box: string | null;
  note: string | null; from_label: string | null; label_url: string | null;
  shippo_rate_id: string | null; shippo_transaction_id: string | null;
  refund_status: string | null; refund_requested_at: string | null;
  purchase_started_at: string | null; purchase_attempted_at: string | null;
  attempt_verified_no_label_at: string | null;
  finalized_at: string | null; shipped_at: string | null; b44_pushed_at: string | null;
  push_epoch: number; created_at: string;
  items: { order_item_id: number; qty: string; sku_code: string; product_id: number; product_external_id: string | null }[];
};

export type QueueOrder = {
  id: number; order_number: string; external_id: string | null; customer_name: string;
  contact_name: string | null; contact_email: string | null; contact_phone: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null;
  state_code: string | null; postal_code: string | null; customer_note: string | null;
};

const QTY_RE = /^\d+(?:\.\d{1,2})?$/;

// The durable photo stash lives in @/lib/photoStash — the SINGLE backing
// store for every unattached capture; pendingPhotos here is only a VIEW
// over it. See that module for the full durability/locking contract.

export function ShippingModal({ order, addresses, shippoKey, shippoHttp, testMode, settings, cfg, userName, groupBuyId, onClose, onShipped, reload }: {
  order: QueueOrder; addresses: RxAddress[]; shippoKey: string; shippoHttp: ShippoHttp; testMode: boolean;
  settings: Record<string, string>; cfg: B44Config; userName: string; groupBuyId: number | null;
  onClose: () => void; onShipped: (items: { product_id: number; qty: number }[]) => void; reload: () => void;
}) {
  const [rawPackable, , , reloadPackable] = useLoadAction(getPackableItems, [order.id], { order_id: order.id });
  const [rawShipments, , , reloadShipments] = useLoadAction(listOrderShipments, [order.id], { order_id: order.id });
  // row boundary: the transport re-types digit-only text — re-string
  const packable = useMemo(() => rows<PackableLine>(rawPackable).map(l => ({
    ...l,
    effective_qty: String(l.effective_qty ?? '0'), attributed_qty: String(l.attributed_qty ?? '0'),
    shipped_qty: String(l.shipped_qty ?? '0'), remaining_qty: String(l.remaining_qty ?? '0'),
    product_external_id: l.product_external_id == null ? null : String(l.product_external_id),
  })), [rawPackable]);
  const shipments = useMemo(() => rows<ShipmentRow>(rawShipments).map(s => ({
    ...s, tracking_number: s.tracking_number == null ? null : String(s.tracking_number),
  })), [rawShipments]);
  // digital products (COA certificates) never go in the box — read-only
  const packLines = packable.filter(l => !l.direct_ship && !l.digital);
  const directLines = packable.filter(l => l.direct_ship && !l.digital);
  const digitalLines = packable.filter(l => l.digital);

  const [doCreateDraft] = useMutateAction(createShipmentDraft);
  const [doRecordManual] = useMutateAction(recordManualShipment);
  const [doClaim] = useMutateAction(markShipmentPurchaseStarted);
  const [doClearLease] = useMutateAction(clearShipmentPurchaseLease);
  const [doClearAttempt] = useMutateAction(clearShipmentAttemptVerified);
  const [doFinalize] = useMutateAction(finalizeShipment);
  const [doDeleteDraft] = useMutateAction(deleteShipmentDraft);
  const [doSetRefund] = useMutateAction(setShipmentRefund);
  const [doMarkPushed] = useMutateAction(markShipmentPushed);
  const [doAddPhoto] = useMutateAction(addShipmentPhoto);
  const [doDeletePhoto] = useMutateAction(deleteShipmentPhoto);
  const [doGetPhoto] = useMutateAction(getShipmentPhoto);
  const [doAppendNote] = useMutateAction(appendOrderAdminNote);
  const [rawPhotos, , , reloadPhotos] = useLoadAction(listShipmentPhotos, [order.id], { order_id: order.id });
  const photos = rows<{ id: number; shipment_id: number; thumb_data: string; created_by: string | null; created_at: string }>(rawPhotos);
  // read action invoked imperatively (getOrderTxRefs precedent): the push's
  // fully-shipped decision needs a JUST-IN-TIME authoritative read, never
  // the modal's hook state
  const [fetchPackable] = useMutateAction(getPackableItems);

  // per-line box quantities, keyed by order_item_id; seeded to remaining
  const [qtys, setQtys] = useState<Record<number, string>>({});
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || packLines.length === 0) return;
    seeded.current = true;
    const q: Record<number, string> = {};
    for (const l of packLines) q[Number(l.order_item_id)] = String(Number(l.remaining_qty));
    setQtys(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packLines.length]);

  const [dims, setDims] = useState({ length: '', width: '', height: '' });
  const [weight, setWeight] = useState('');
  const [weightTouched, setWeightTouched] = useState(false);
  const [shipFrom, setShipFrom] = useState('');
  const [box, setBox] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [ratesLoading, setRatesLoading] = useState(false);
  const [ratesResult, setRatesResult] = useState<{ rates: ShippoRate[]; allRateCount: number; messages: string[]; sig: string } | null>(null);
  const [pickedRate, setPickedRate] = useState('');
  const [purchaseMsg, setPurchaseMsg] = useState('');
  const [purchasing, setPurchasing] = useState(false);
  const [success, setSuccess] = useState<PurchaseResult | null>(null);
  const [pushMsg, setPushMsg] = useState('');
  const [manualMode, setManualMode] = useState(false);
  const [mCarrier, setMCarrier] = useState('usps');
  const [mCarrierOther, setMCarrierOther] = useState('');
  const [mTracking, setMTracking] = useState('');
  const [mCost, setMCost] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualSuccess, setManualSuccess] = useState('');
  const [pendingFinalize, setPendingFinalize] = useState<Record<number, PurchaseResult>>({});
  const [recoverTxn, setRecoverTxn] = useState<Record<number, string>>({});
  const [rowMsg, setRowMsg] = useState<Record<number, string>>({});
  // ---- package photos: captured on the phone BEFORE shipping. Every
  // capture goes STRAIGHT into the durable stash (see StashedPhoto above);
  // pendingPhotos is only the visible VIEW of this order's unbound
  // (shipment_id null) entries — closing/unmounting the dialog loses
  // nothing. Entries leave the stash only on a verified attach or an
  // explicit operator removal. ----
  const [pendingPhotos, setPendingPhotos] = useState<StashedPhoto[]>([]);
  const refreshPendingView = async () =>
    setPendingPhotos((await readStash()).filter(s => s.order_id === order.id && s.shipment_id === null));
  const [photoMsg, setPhotoMsg] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [viewPhoto, setViewPhoto] = useState<string | null>(null);
  const photoTarget = useRef<'pending' | number>('pending');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 'refused' = the server said no (quota full, shipment voided or gone) —
  // retrying the same payload cannot succeed. 'error' = ambiguous transport
  // failure — the insert MAY have committed; the server's same-content
  // replay (add_shipment_photo SHA-256 short-circuit) makes retrying safe.
  type UploadResult = 'ok' | 'refused' | 'error';
  const tryUpload = async (shipmentId: number, ph: CapturedPhoto, actor: string = userName, replay = false): Promise<UploadResult> => {
    try {
      const res = await doAddPhoto({ shipment_id: shipmentId, image_data: ph.full, thumb_data: ph.thumb, actor, replay }) as unknown[] | null;
      return (Array.isArray(res) ? res.length > 0 : !!res) ? 'ok' : 'refused';
    } catch {
      return 'error';
    }
  };

  // on open: show this order's pending entries, then auto-replay any
  // shipment-bound failures. Each stash mutation is a synchronous
  // per-entry op keyed by s.key — no stale-snapshot bulk write.
  const stashRetried = useRef(false);
  useEffect(() => {
    if (stashRetried.current) return;
    stashRetried.current = true;
    (async () => {
      await refreshPendingView();
      const bound = (await readStash()).filter(s => s.order_id === order.id && s.shipment_id !== null);
      if (bound.length === 0) return;
      let recovered = 0, moved = 0, kept = 0, allDurable = true;
      for (const s of bound) {
        // replay=true: the server refuses to resurrect an image the
        // operator explicitly deleted from that shipment
        const r = await tryUpload(s.shipment_id as number, s, s.actor || userName, true);
        if (r === 'ok') {
          recovered += 1;
          if (!(await stashRemove(s.key))) allDurable = false;
        } else if (r === 'refused') {
          // shipment gone (draft recreated?), quota full, or deliberately
          // deleted — the entry STAYS DURABLE, unbound and marked
          // recovered: visible, but it will not ride another box unless
          // the operator explicitly says so
          moved += 1;
          if (!(await stashUpsert({ ...s, shipment_id: null, recovered: true }))) allDurable = false;
        } else kept += 1; // stays bound in the stash; retried on next open
      }
      await refreshPendingView();
      const parts: string[] = [];
      if (recovered > 0) parts.push(`${recovered} previously failed photo(s) attached.`);
      if (moved > 0) parts.push(`${moved} saved photo(s) could not attach to their original shipment (deleted, quota full, or previously removed) — now in the pending list below marked "recovered". They will NOT attach automatically: press "use" on each to allow it onto the next shipment, or remove it.`);
      if (kept > 0) parts.push(`${kept} saved photo(s) still could not attach — they stay saved on this device and retry when this dialog reopens.`);
      if (!allDurable) parts.push(`Warning: this device's storage is unavailable — unattached photos survive only while this page stays open.`);
      if (parts.length > 0) setPhotoMsg(parts.join(' '));
      if (recovered > 0) reloadPhotos();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  const capturePhotos = (target: 'pending' | number) => {
    photoTarget.current = target;
    fileInputRef.current?.click();
  };

  const onFilesPicked = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setPhotoBusy(true); setPhotoMsg('');
    const errors: string[] = [];
    try {
      for (const f of Array.from(files)) {
        try {
          const ph = await compressImageToDataUrl(f);
          // the capture is the only copy — it enters the DURABLE stash
          // before anything else is attempted
          const entry: StashedPhoto = { ...ph, shipment_id: null, order_id: order.id, ts: Date.now(), actor: userName, key: newStashKey() };
          if (photoTarget.current === 'pending') {
            if (!(await stashUpsert(entry))) errors.push(`${f.name}: kept for this shipment, but this device's storage is unavailable — it survives only while this page stays open.`);
            await refreshPendingView();
          } else {
            const shipmentId = photoTarget.current;
            // durability FIRST: the entry is stashed, bound to its target
            // shipment, before any network work — a crash or reload
            // mid-upload leaves a bound entry that auto-replays on reopen
            // (the server's same-content replay dedupes a committed one)
            if (!(await stashUpsert({ ...entry, shipment_id: shipmentId }))) {
              errors.push(`${f.name}: this device's storage is unavailable — the photo survives only while this page stays open.`);
            }
            const r = await tryUpload(shipmentId, ph);
            if (r === 'ok') {
              // attached and verified — release the stashed copy
              await stashRemove(entry.key);
            } else if (r === 'refused') {
              // stays durable, unbound and RECOVERED: visible, never
              // auto-attached to a different box
              const durable = await stashUpsert({ ...entry, shipment_id: null, recovered: true });
              await refreshPendingView();
              errors.push(`${f.name}: refused — the quota (5 photos / 5MB) is full, the shipment was voided, or this exact photo already rides another box of this order. Kept in the pending list marked "recovered"${durable ? '' : ' (storage unavailable — it survives only while this page stays open)'}: press "use" to allow it onto the next shipment, or remove it.`);
            } else {
              const durable = await stashUpsert({ ...entry, shipment_id: shipmentId });
              errors.push(durable
                ? `${f.name}: did not attach (transport error) — saved on this device and auto-retried next time this dialog opens.`
                : `${f.name}: did not attach AND could not be saved to this device (storage unavailable) — it survives only while this page stays open. Retry now or re-take the photo.`);
            }
          }
        } catch (e: unknown) {
          errors.push(e instanceof Error ? e.message : `${f.name}: failed`);
        }
      }
      if (photoTarget.current !== 'pending') reloadPhotos();
      if (errors.length > 0) setPhotoMsg(errors.join(' '));
    } finally {
      setPhotoBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // attach the pre-ship captures to the shipment that just came into
  // existence. The stash stays the backing store throughout: a verified
  // attach removes its entry, a refusal leaves it unbound and visible, an
  // ambiguous error re-binds it to this shipment for auto-retry — never
  // silently dropped, never blocking the shipment
  const uploadPendingPhotos = async (shipmentId: number) => {
    // recovered entries are excluded: evidence never migrates to a
    // different box without the operator's explicit per-photo "use"
    const mine = (await readStash()).filter(s => s.order_id === order.id && s.shipment_id === null && !s.recovered);
    if (mine.length === 0) return;
    let refused = 0, errored = 0, attached = 0, allDurable = true;
    for (const s of mine) {
      // bind FIRST, synchronously: if the insert commits but the tab dies
      // before we hear back, the entry replays against THIS shipment on
      // reopen (deduped server-side) instead of riding a later box as an
      // ordinary pending photo — cross-shipment migration is impossible
      if (!(await stashUpsert({ ...s, shipment_id: shipmentId }))) allDurable = false;
      const r = await tryUpload(shipmentId, s, s.actor || userName);
      if (r === 'ok') {
        attached += 1;
        if (!(await stashRemove(s.key))) allDurable = false;
      } else if (r === 'refused') {
        // refused by the very shipment it was meant for — it becomes a
        // recovered entry, visible and never auto-consumed again
        refused += 1;
        if (!(await stashUpsert({ ...s, shipment_id: null, recovered: true }))) allDurable = false;
      } else {
        errored += 1; // stays bound to this shipment for safe replay
      }
    }
    await refreshPendingView();
    const parts: string[] = [];
    if (refused > 0) parts.push(`${refused} photo(s) refused (quota full, shipment voided, or already on another box of this order) — kept pending, marked "recovered"; press "use" to allow one onto the next shipment.`);
    if (errored > 0) parts.push(`${errored} photo(s) did not attach — saved on this device and auto-retried next time this dialog opens.`);
    if (!allDurable) parts.push(`Warning: this device's storage is unavailable — unattached photos survive only while this page stays open.`);
    if (parts.length > 0) setPhotoMsg(parts.join(' '));
    if (attached > 0 || refused > 0 || errored > 0) reloadPhotos();
  };

  const removePhoto = async (photoId: number, shipmentId: number) => {
    if (!window.confirm('Remove this package photo? The removal is audited — its thumbnail and fingerprint stay in the audit history.')) return;
    await doDeletePhoto({ photo_id: photoId, shipment_id: shipmentId, actor: userName }).catch(() => null);
    reloadPhotos();
  };

  // the full image loads on demand — list rows carry only thumbnails
  const enlargePhoto = async (photoId: number, shipmentId: number) => {
    try {
      const res = await doGetPhoto({ photo_id: photoId, shipment_id: shipmentId }) as { image_data?: string }[] | null;
      const row = Array.isArray(res) && res.length > 0 ? res[0] : null;
      if (row?.image_data) setViewPhoto(String(row.image_data));
      else setPhotoMsg('Could not load the full photo — it may have been removed.');
    } catch {
      setPhotoMsg('Could not load the full photo — retry.');
    }
  };

  // refs, not state: React re-renders lag double-clicks, and these
  // buttons spend REAL money
  const purchaseInFlight = useRef(false);
  const refundInFlight = useRef(false);
  const manualInFlight = useRef(false);
  const pushInFlight = useRef(false);

  const chosen = packLines
    .map(l => ({ line: l, qty: (qtys[Number(l.order_item_id)] ?? '').trim() }))
    .filter(c => c.qty !== '' && Number(c.qty) > 0);
  const isPartial = packLines.some(l => {
    const q = (qtys[Number(l.order_item_id)] ?? '').trim();
    return Number(q || 0) !== Number(l.remaining_qty);
  }) || packLines.some(l => Number(l.shipped_qty) > 0 || Number(l.attributed_qty) > 0);

  const validateChosen = (): string | null => {
    if (chosen.length === 0) return 'Enter a quantity on at least one line — a box must contain something.';
    for (const c of chosen) {
      if (!QTY_RE.test(c.qty)) return `${c.line.sku_code}: quantity must be a positive number (max 2 decimals).`;
      if (Number(c.qty) > Number(c.line.remaining_qty)) return `${c.line.sku_code}: only ${fmtNum(c.line.remaining_qty)} remaining to pack (the rest is already in another shipment or draft).`;
    }
    return null;
  };

  // weight prefill: sum of chosen qty x unit weight (+ box tare setting),
  // oz -> lb, 1 decimal. Frozen once the operator edits it by hand.
  const missingWeightSkus = chosen.filter(c => c.line.unit_weight_oz == null).map(c => c.line.sku_code);
  const calcWeightLb = () => {
    const oz = chosen.reduce((s, c) => s + Number(c.qty || 0) * Number(c.line.unit_weight_oz || 0), 0)
      + Number(settings.default_box_tare_oz || 0);
    return oz > 0 ? String(Math.max(0.1, Math.round((oz / 16) * 10) / 10)) : '';
  };
  useEffect(() => {
    if (!weightTouched) setWeight(calcWeightLb());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(qtys), packable.length, weightTouched]);

  const fromRow = addresses.find(a => String(a.id) === shipFrom) || null;
  const shipTo: ShippoAddress | null = order.address_line1 ? {
    name: order.contact_name || order.customer_name, street1: order.address_line1,
    street2: order.address_line2 || undefined as unknown as string,
    city: order.city || '', state: order.state_code || '', zip: order.postal_code || '', country: 'US',
    phone: order.contact_phone || undefined as unknown as string,
    email: order.contact_email || undefined as unknown as string,
  } : null;
  const expectedTo = {
    street1: order.address_line1 || '', street2: order.address_line2 || '',
    city: order.city || '', state: order.state_code || '', zip: order.postal_code || '',
  };

  // rate signature: ship-from CONTENTS + ship-to + dims/weight + the CHOSEN
  // QUANTITIES (an attribution edit changes the draft, so it re-quotes)
  const quoteSig = JSON.stringify({ shipFrom, from: fromRow, to: expectedTo, dims, weight, chosen: chosen.map(c => [c.line.order_item_id, c.qty]) });
  useEffect(() => {
    if (ratesResult && ratesResult.sig !== quoteSig) { setRatesResult(null); setPickedRate(''); setPurchaseMsg(''); }
  }, [quoteSig, ratesResult]);

  const fetchRates = async () => {
    setMsg(''); setRatesResult(null); setPickedRate('');
    if (!shippoKey) { setMsg('Add your Shippo API token in Settings first.'); return; }
    if (!fromRow) { setMsg('Pick the ship-from address.'); return; }
    if (!shipTo) { setMsg('This order has no street address — fix it in the order sheet first.'); return; }
    const lineError = validateChosen();
    if (lineError) { setMsg(lineError); return; }
    for (const k of ['length', 'width', 'height'] as const) {
      if (!QTY_RE.test(dims[k].trim()) || !(Number(dims[k]) > 0)) { setMsg('Box dimensions must be positive numbers (inches).'); return; }
    }
    if (!QTY_RE.test(weight.trim()) || !(Number(weight) > 0)) { setMsg('Weight must be a positive number (lb).'); return; }
    setRatesLoading(true);
    try {
      const res = await getRates(shippoHttp, shippoKey, {
        name: fromRow.name, street1: fromRow.street1, street2: fromRow.street2 || undefined as unknown as string,
        city: fromRow.city, state: fromRow.state, zip: fromRow.zip, country: fromRow.country || 'US',
        phone: fromRow.phone || undefined as unknown as string, email: fromRow.email || undefined as unknown as string,
      }, shipTo, {
        length: dims.length.trim(), width: dims.width.trim(), height: dims.height.trim(),
        distance_unit: 'in', weight: weight.trim(), mass_unit: 'lb',
      });
      setRatesResult({ ...res, sig: quoteSig });
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Failed to fetch rates');
    } finally {
      setRatesLoading(false);
    }
  };

  // EVERY post-purchase finalize goes through here: a THROWN action failure
  // is treated exactly like a zero-row refusal so the recovery branch
  // (pendingFinalize + label URL + transaction id) always runs
  const persistFinalize = async (shipmentId: number, result: PurchaseResult, rateFallback: string): Promise<{ ok: boolean; addressDrift: boolean; trackingCollision: boolean }> => {
    try {
      const fin = await doFinalize({
        shipment_id: shipmentId, transaction_id: result.transactionId,
        tracking_number: result.trackingNumber, label_url: result.labelUrl,
        rate_id: result.rateId || rateFallback, actor: userName,
      }) as unknown[] | null;
      const row = Array.isArray(fin) && fin.length > 0 ? fin[0] as { address_drift?: string | boolean; tracking_collision?: string | boolean } : null;
      if (!row) return { ok: false, addressDrift: false, trackingCollision: false };
      return {
        ok: true,
        addressDrift: row.address_drift === true || row.address_drift === 'true',
        trackingCollision: row.tracking_collision === true || row.tracking_collision === 'true',
      };
    } catch {
      return { ok: false, addressDrift: false, trackingCollision: false };
    }
  };
  const finWarnings = (fin: { addressDrift: boolean; trackingCollision: boolean }) => [
    fin.addressDrift ? 'WARNING: the order\'s address changed since this label was quoted — the label may carry a STALE destination. Verify before shipping the box (refund/re-buy if wrong).' : '',
    fin.trackingCollision ? 'WARNING: this tracking number already appears on another recent shipment or transfer — verify at Shippo; one of the two may be a double-record.' : '',
  ].filter(Boolean).join(' ');

  const runPush = async (shipmentId: number, pushEpoch: number, carrier: string, tracking: string, items: { order_item_id: number; qty: string; sku: string }[]) => {
    if (pushInFlight.current) return;
    pushInFlight.current = true;
    setPushMsg('Pushing to the ordering app…');
    try {
      // JUST-IN-TIME authoritative read: the fully-shipped decision (which
      // can advance the upstream order to 'shipped') must reflect what the
      // DB says NOW — after this finalize, and after anything another
      // session did meanwhile — never this modal's stale hook rows
      let freshRows: PushPackableLine[];
      try {
        const res = await fetchPackable({ order_id: order.id }) as unknown[] | null;
        freshRows = (Array.isArray(res) ? res : []).map(r => {
          const l = r as PackableLine;
          return {
            order_item_id: Number(l.order_item_id),
            product_external_id: l.product_external_id == null ? null : String(l.product_external_id),
            sku_code: l.sku_code, effective_qty: String(l.effective_qty), shipped_qty: String(l.shipped_qty),
            direct_ship: l.direct_ship, direct_fulfilled_at: l.direct_fulfilled_at, digital: l.digital,
          };
        });
        if (freshRows.length === 0) throw new Error('empty read');
      } catch {
        setPushMsg('Push not sent — could not re-read the order\'s packing state (needed to decide the upstream status). The shipment is saved; use "Push upstream" to retry.');
        return;
      }
      const out = await pushShipmentUpstream({
        cfg, externalId: order.external_id || '', orderId: order.id, orderNumber: order.order_number,
        shipmentId, pushEpoch, carrier, tracking,
        shippedItems: items.map(i => ({ sku: i.sku, qty: i.qty })),
        packable: freshRows, userName,
        appendNote: doAppendNote, markPushed: doMarkPushed,
      });
      setPushMsg(out.message);
      reloadShipments();
    } finally {
      pushInFlight.current = false;
    }
  };

  const purchase = async () => {
    if (purchaseInFlight.current) return;   // synchronous double-click guard
    purchaseInFlight.current = true;
    setPurchasing(true); setPurchaseMsg('');
    try {
      const rate = ratesResult?.rates.find(r => r.object_id === pickedRate);
      if (!rate || !shipTo || !fromRow) { setPurchaseMsg('Pick a rate first.'); return; }
      // belt for races the invalidation effect can't win
      if (ratesResult!.sig !== quoteSig) {
        setPurchaseMsg('The shipment details changed after these rates were fetched — re-fetch rates.');
        setRatesResult(null); setPickedRate('');
        return;
      }
      const lineError = validateChosen();
      if (lineError) { setPurchaseMsg(lineError + ' Nothing was purchased.'); return; }
      const expectedFrom = {
        name: fromRow.name, street1: fromRow.street1, street2: fromRow.street2,
        city: fromRow.city, state: fromRow.state, zip: fromRow.zip,
        country: fromRow.country, phone: fromRow.phone, email: fromRow.email,
      };
      // 1. DRAFT FIRST, atomic with its attribution — the server re-proves
      //    every gate row-locked (remaining, money, ship-to, ship-from)
      let draftId: number | null = null;
      let claimedAt = '';
      try {
        const res = await doCreateDraft({
          order_id: order.id, group_buy_id: groupBuyId ?? '',
          ship_from_address_id: Number(shipFrom),
          expected_from: JSON.stringify(expectedFrom), expected_to: JSON.stringify(expectedTo),
          parcel: JSON.stringify({ length: dims.length.trim(), width: dims.width.trim(), height: dims.height.trim(), distance_unit: 'in', weight: weight.trim(), mass_unit: 'lb' }),
          carrier: rate.provider, servicelevel: rate.servicelevel?.name || rate.servicelevel?.token || '',
          rate_amount: rate.amount, rate_currency: rate.currency, shippo_rate_id: rate.object_id,
          items: JSON.stringify(chosen.map(c => ({ order_item_id: String(c.line.order_item_id), qty: c.qty }))),
          box: box.trim(), note: note.trim(), actor: userName,
        }) as unknown[] | null;
        const row = Array.isArray(res) && res.length > 0 ? res[0] as { id: string; claimed_at?: string } : null;
        draftId = row ? Number(row.id) : null;
        claimedAt = row?.claimed_at || '';
      } catch (e: unknown) {
        const m = e instanceof Error ? e.message : '';
        setPurchaseMsg(m.includes('shipments_rate_unique')
          ? 'This exact rate was already purchased (double-click?) — check the shipments below before buying again.'
          : (m || 'Failed to save the shipment draft.') + ' Nothing was saved or purchased.');
        return;
      }
      if (!draftId) {
        setPurchaseMsg('Draft not saved — nothing was purchased. Possible causes: a quantity exceeds what remains to pack (another box may have just taken it), the order went on hold / its payment state changed, its ship-to address was corrected since the quote, or the ship-from address was edited or archived — reload and re-quote.');
        reloadPackable(); reloadShipments();
        return;
      }
      // the pre-ship package photos attach to the draft NOW — before any
      // money moves, so even a failed purchase leaves the evidence with
      // its draft (failures stay pending and visible, never blocking)
      await uploadPendingPhotos(draftId);
      // 2. HEARTBEAT immediately before money moves
      if (claimedAt) {
        const hb = await doClaim({ shipment_id: draftId, prior_claimed_at: claimedAt, actor: userName }) as unknown[] | null;
        const hbRow = Array.isArray(hb) && hb.length > 0 ? hb[0] as { claimed_at?: string } : null;
        if (!hbRow) {
          setPurchaseMsg('Not purchased — this draft was deleted or claimed by another session while this page was idle, or the order\'s address/hold/payment state changed. Nothing was charged; reload and re-quote.');
          reloadShipments();
          return;
        }
        claimedAt = hbRow.claimed_at || claimedAt;
      }
      // 3. buy the label (single attempt inside)
      let result: PurchaseResult;
      try {
        result = await purchaseLabel(shippoHttp, shippoKey, rate.object_id);
      } catch (e: unknown) {
        if (e instanceof ShippoPurchaseRefusedError && claimedAt) {
          await doClearLease({ shipment_id: draftId, claimed_at: claimedAt, actor: userName }).catch(() => null);
        }
        setPurchaseMsg((e instanceof Error ? e.message : 'Purchase failed') + ' — the draft is saved below; retry or delete it there.');
        reloadShipments();
        return;
      }
      // 4. persist — retryable from memory if this write fails or THROWS
      const fin = await persistFinalize(draftId, result, rate.object_id);
      if (!fin.ok) {
        setPendingFinalize(m => ({ ...m, [draftId!]: result }));
        setPurchaseMsg(`LABEL PURCHASED (transaction ${result.transactionId}) but saving failed — label: ${result.labelUrl} — use "Retry save" on the shipment below; do NOT purchase again.`);
        reloadShipments();
        return;
      }
      setSuccess(result);
      const shippedItems = chosen.map(c => ({ order_item_id: Number(c.line.order_item_id), qty: c.qty, sku: c.line.sku_code }));
      onShipped(chosen.map(c => ({ product_id: Number(c.line.product_id), qty: Number(c.qty) })));
      setRatesResult(null); setPickedRate('');
      reloadPackable(); reloadShipments(); reload();
      const warn = finWarnings(fin);
      if (warn) setPurchaseMsg(warn);
      // a just-created draft is born at push_epoch 0; a flip that raced
      // this purchase bumps it and the stamp CAS refuses
      await runPush(draftId, 0, rate.provider, result.trackingNumber || '', shippedItems);
    } finally {
      purchaseInFlight.current = false;
      setPurchasing(false);
    }
  };

  const recordManual = async () => {
    if (manualInFlight.current) return;
    manualInFlight.current = true;
    setManualBusy(true); setMsg('');
    try {
      const carrier = mCarrier === 'other' ? mCarrierOther.trim() : mCarrier;
      if (!carrier) { setMsg('Pick or type the carrier.'); return; }
      // tracking stays a string end-to-end; a re-typed JS number past safe
      // range would be silently rounded — fail closed (platform precedent)
      if (typeof (mTracking as unknown) === 'number' && !Number.isSafeInteger(mTracking as unknown as number)) { setMsg('Tracking number unreadable — re-enter it.'); return; }
      if (!mTracking.trim()) { setMsg('Enter the tracking number from the label.'); return; }
      if (mCost.trim() !== '' && (!QTY_RE.test(mCost.trim()) || !(Number(mCost) > 0))) { setMsg('Cost must be a positive number, or blank.'); return; }
      const lineError = validateChosen();
      if (lineError) { setMsg(lineError); return; }
      const expectedFrom = fromRow ? {
        name: fromRow.name, street1: fromRow.street1, street2: fromRow.street2,
        city: fromRow.city, state: fromRow.state, zip: fromRow.zip,
        country: fromRow.country, phone: fromRow.phone, email: fromRow.email,
      } : null;
      let recordedId: number | null = null;
      try {
        const res = await doRecordManual({
          order_id: order.id, group_buy_id: groupBuyId ?? '',
          ship_from_address_id: fromRow ? String(fromRow.id) : '',
          expected_from: expectedFrom ? JSON.stringify(expectedFrom) : '{}',
          expected_to: JSON.stringify(expectedTo),
          carrier, tracking_number: mTracking.trim(), cost: mCost.trim(),
          items: JSON.stringify(chosen.map(c => ({ order_item_id: String(c.line.order_item_id), qty: c.qty }))),
          box: box.trim(), note: note.trim(), actor: userName,
        }) as unknown[] | null;
        const row = Array.isArray(res) && res.length > 0 ? res[0] as { id: string } : null;
        recordedId = row ? Number(row.id) : null;
      } catch (e: unknown) {
        // a born-finalized insert may have committed before an error
        // surfaced — say so honestly instead of "nothing was recorded"
        setMsg((e instanceof Error ? e.message : 'Recording failed') + ' — the record may or may not have saved; check the shipments list below before re-entering.');
        reloadShipments();
        return;
      }
      if (!recordedId) {
        setMsg('Not recorded — possible causes: a quantity exceeds remaining, this tracking number is already on a shipment or transfer from the last 120 days (retyped a label that\'s already recorded?), the order\'s hold/payment/address state changed, or the ship-from address was edited. Nothing was saved.');
        reloadPackable(); reloadShipments();
        return;
      }
      await uploadPendingPhotos(recordedId);
      setManualSuccess(mTracking.trim());
      const shippedItems = chosen.map(c => ({ order_item_id: Number(c.line.order_item_id), qty: c.qty, sku: c.line.sku_code }));
      onShipped(chosen.map(c => ({ product_id: Number(c.line.product_id), qty: Number(c.qty) })));
      reloadPackable(); reloadShipments(); reload();
      await runPush(recordedId, 0, carrier, mTracking.trim().toUpperCase().replace(/\s/g, ''), shippedItems);
    } finally {
      manualInFlight.current = false;
      setManualBusy(false);
    }
  };

  // EVERY successful finalize — primary, retry, recovery — converges here:
  // session pool decrement, reloads, and the automatic Base44 push. A
  // recovered shipment must reach the same postconditions as a happy-path
  // one, or Base44 silently lacks its tracking until someone notices.
  const shipmentLanded = async (s: ShipmentRow, carrier: string, tracking: string) => {
    const items = (s.items || []).map(i => ({ order_item_id: Number(i.order_item_id), qty: String(i.qty), sku: i.sku_code }));
    onShipped((s.items || []).map(i => ({ product_id: Number(i.product_id), qty: Number(i.qty) })));
    reloadPackable(); reloadShipments(); reload();
    await runPush(s.id, Number(s.push_epoch || 0), carrier, tracking, items);
  };

  // ---- draft recovery + refund controls (ports of the transfers panel) ----
  const retryFinalize = async (s: ShipmentRow) => {
    const pending = pendingFinalize[s.id];
    if (!pending) return;
    const fin = await persistFinalize(s.id, pending, s.shippo_rate_id || '');
    if (fin.ok) {
      setPendingFinalize(m => { const n = { ...m }; delete n[s.id]; return n; });
      setRowMsg(m => ({ ...m, [s.id]: finWarnings(fin) || 'Saved.' }));
      await shipmentLanded(s, s.carrier || '', pending.trackingNumber || '');
    } else setRowMsg(m => ({ ...m, [s.id]: 'Save failed again — the label URL is preserved here; keep retrying.' }));
  };

  const recoverByTxn = async (s: ShipmentRow) => {
    const txn = (recoverTxn[s.id] || '').trim();
    if (!txn) { setRowMsg(m => ({ ...m, [s.id]: 'Paste the transaction id from the error message or the Shippo dashboard.' })); return; }
    try {
      const result = await getTransaction(shippoHttp, shippoKey, txn);
      // RATE-BOUND: the draft's stored rate is the proof of ownership
      if (!s.shippo_rate_id || result.rateId !== s.shippo_rate_id) {
        setRowMsg(m => ({ ...m, [s.id]: `That transaction was purchased against a different rate than this draft (transaction rate ${result.rateId || 'unknown'}, draft rate ${s.shippo_rate_id || 'missing'}) — refusing to attach it.` }));
        return;
      }
      const fin = await persistFinalize(s.id, result, result.rateId || '');
      if (fin.ok) { setRowMsg(m => ({ ...m, [s.id]: finWarnings(fin) || 'Recovered and saved.' })); await shipmentLanded(s, s.carrier || '', result.trackingNumber || ''); }
      else setRowMsg(m => ({ ...m, [s.id]: 'Transaction found but saving failed — retry.' }));
    } catch (e: unknown) {
      setRowMsg(m => ({ ...m, [s.id]: e instanceof Error ? e.message : 'Recovery failed' }));
    }
  };

  const retryPurchase = async (s: ShipmentRow) => {
    if (purchaseInFlight.current || !s.shippo_rate_id) return;
    purchaseInFlight.current = true;
    try {
      let existing: Awaited<ReturnType<typeof findTransactionByRate>>;
      try {
        existing = await findTransactionByRate(shippoHttp, shippoKey, s.shippo_rate_id, s.created_at);
      } catch (e: unknown) {
        setRowMsg(m => ({ ...m, [s.id]: e instanceof Error ? e.message : 'Could not verify with Shippo — not purchasing.' }));
        return;
      }
      if (existing) {
        const fin0 = await persistFinalize(s.id, existing, s.shippo_rate_id);
        if (fin0.ok) { setRowMsg(m => ({ ...m, [s.id]: finWarnings(fin0) || 'An existing label was found and recovered.' })); await shipmentLanded(s, s.carrier || '', existing.trackingNumber || ''); }
        else setRowMsg(m => ({ ...m, [s.id]: `An existing label was found (${existing.transactionId}) but saving failed — retry.` }));
        return;
      }
      if (s.purchase_attempted_at) {
        await doClearAttempt({ shipment_id: s.id, observed_attempted_at: s.purchase_attempted_at, actor: userName }).catch(() => null);
      }
      if (!window.confirm('No existing label found at Shippo for this rate. Buy it now? Note: rates expire after ~7 days.')) return;
      const claim = await doClaim({ shipment_id: s.id, prior_claimed_at: '', actor: userName }) as unknown[] | null;
      const claimRow = Array.isArray(claim) && claim.length > 0 ? claim[0] as { claimed_at?: string } : null;
      if (!claimRow) {
        setRowMsg(m => ({ ...m, [s.id]: 'Not purchased — the draft no longer exists, another purchase attempt is fresh (<10 min), or the order\'s address/hold/payment state changed since the draft. Nothing was charged.' }));
        reloadShipments();
        return;
      }
      let result: PurchaseResult;
      try {
        result = await purchaseLabel(shippoHttp, shippoKey, s.shippo_rate_id);
      } catch (e: unknown) {
        if (e instanceof ShippoPurchaseRefusedError && claimRow.claimed_at) {
          await doClearLease({ shipment_id: s.id, claimed_at: claimRow.claimed_at, actor: userName }).catch(() => null);
        }
        throw e;
      }
      const fin = await persistFinalize(s.id, result, s.shippo_rate_id);
      if (fin.ok) { setRowMsg(m => ({ ...m, [s.id]: finWarnings(fin) || 'Purchased and saved.' })); await shipmentLanded(s, s.carrier || '', result.trackingNumber || ''); }
      else {
        setPendingFinalize(m => ({ ...m, [s.id]: result }));
        setRowMsg(m => ({ ...m, [s.id]: `Label purchased (${result.transactionId}) but saving failed — ${result.labelUrl} — use Retry save.` }));
      }
    } catch (e: unknown) {
      setRowMsg(m => ({ ...m, [s.id]: e instanceof Error ? e.message : 'Purchase failed' }));
    } finally {
      purchaseInFlight.current = false;
    }
  };

  const deleteDraft = async (s: ShipmentRow) => {
    // a draft may only be deleted after Shippo PROVES no label exists —
    // the rate id is the only recovery handle for a label paid in a lost
    // session. No key = no verification = no delete.
    if (!shippoKey) { setRowMsg(m => ({ ...m, [s.id]: 'Not deleted — no Shippo API token, so it cannot be verified that no label was purchased. Add the token in Settings first.' })); return; }
    if (!s.shippo_rate_id) { setRowMsg(m => ({ ...m, [s.id]: 'Not deleted — this draft has no rate id to verify against Shippo.' })); return; }
    try {
      const existing = await findTransactionByRate(shippoHttp, shippoKey, s.shippo_rate_id, s.created_at);
      if (existing) {
        const fin = await persistFinalize(s.id, existing, s.shippo_rate_id);
        setRowMsg(m => ({ ...m, [s.id]: fin.ok
          ? (finWarnings(fin) || 'A PURCHASED label exists for this draft — recovered instead of deleting.')
          : `A PURCHASED label exists (${existing.transactionId}) — recovery save failed, retry.` }));
        if (fin.ok) await shipmentLanded(s, s.carrier || '', existing.trackingNumber || '');
        else { reloadPackable(); reloadShipments(); reload(); }
        return;
      }
    } catch (e: unknown) {
      setRowMsg(m => ({ ...m, [s.id]: e instanceof Error ? e.message : 'Could not verify with Shippo — not deleting.' }));
      return;
    }
    if (s.purchase_attempted_at) {
      await doClearAttempt({ shipment_id: s.id, observed_attempted_at: s.purchase_attempted_at, actor: userName }).catch(() => null);
    }
    if (!window.confirm('Delete this shipment draft? Shippo confirmed no label was purchased for it; its quantities return to remaining.')) return;
    const del = await doDeleteDraft({ shipment_id: s.id, actor: userName }) as unknown[] | null;
    if (!(Array.isArray(del) ? del.length > 0 : !!del)) {
      setRowMsg(m => ({ ...m, [s.id]: 'Not deleted — a purchase attempt started within the last 10 minutes (possibly the other admin), or it was just finalized. Wait, then retry.' }));
    }
    reloadPackable(); reloadShipments(); reload();
  };

  const refund = async (s: ShipmentRow) => {
    if (!s.shippo_transaction_id || refundInFlight.current) return;
    if (!shippoKey) { setRowMsg(m => ({ ...m, [s.id]: 'No Shippo API token is set (Settings) — the refund request cannot be sent.' })); return; }
    if (!window.confirm(`Request a refund for this label (${fmtUSD(s.rate_amount || s.label_cost_usd)})? Carrier refunds settle over days and only succeed for UNUSED labels. When "Re-check" records SUCCESS, this shipment is VOIDED: its quantities return to remaining and the order re-enters the pack queue.`)) return;
    refundInFlight.current = true;
    try {
      const mark = await doSetRefund({ shipment_id: s.id, refund_status: 'REQUESTING', prior_requested_at: '', actor: userName }) as unknown[] | null;
      const markRow = Array.isArray(mark) && mark.length > 0 ? mark[0] as { requested_at?: string } : null;
      if (!markRow) {
        setRowMsg(m => ({ ...m, [s.id]: 'Not sent — a refund for this label was already requested (possibly by the other admin). Use "Re-check".' }));
        reloadShipments();
        return;
      }
      if (markRow.requested_at) {
        const hb = await doSetRefund({ shipment_id: s.id, refund_status: 'REQUESTING', prior_requested_at: markRow.requested_at, actor: userName }) as unknown[] | null;
        if (!(Array.isArray(hb) && hb.length > 0)) {
          setRowMsg(m => ({ ...m, [s.id]: 'Not sent — this request marker was cleared or superseded while the page was idle. Use "Re-check" before requesting again.' }));
          reloadShipments();
          return;
        }
      }
      try {
        const status = await requestRefund(shippoHttp, shippoKey, s.shippo_transaction_id);
        await doSetRefund({ shipment_id: s.id, refund_status: status, prior_requested_at: '', actor: userName });
      } catch (e: unknown) {
        setRowMsg(m => ({ ...m, [s.id]: (e instanceof Error ? e.message : 'Refund request failed') + ' The row stays REQUESTING — use "Re-check" to reconcile; do not assume it failed.' }));
      }
      reloadShipments();
    } finally {
      refundInFlight.current = false;
    }
  };

  const recheckRefund = async (s: ShipmentRow) => {
    if (!s.shippo_transaction_id || refundInFlight.current) return;
    if (!shippoKey) { setRowMsg(m => ({ ...m, [s.id]: 'No Shippo API token is set (Settings) — cannot check.' })); return; }
    refundInFlight.current = true;
    try {
      const status = await findRefundByTransaction(shippoHttp, shippoKey, s.shippo_transaction_id, s.created_at);
      if (status) {
        await doSetRefund({ shipment_id: s.id, refund_status: status, prior_requested_at: '', actor: userName });
        setRowMsg(m => ({ ...m, [s.id]: status === 'SUCCESS' ? 'Refund SUCCESS — this shipment is voided; its quantities returned to remaining.' : `Refund status: ${status}.` }));
      } else {
        if (!window.confirm('Shippo\'s FULL refund listing shows no refund for this label. Clear the marker so a refund can be requested again? Only confirm if the original request never reached Shippo.')) {
          setRowMsg(m => ({ ...m, [s.id]: 'Marker kept — Re-check again later.' }));
          return;
        }
        const cleared = await doSetRefund({ shipment_id: s.id, refund_status: '', prior_requested_at: '', actor: userName }) as unknown[] | null;
        setRowMsg(m => ({ ...m, [s.id]: (Array.isArray(cleared) && cleared.length > 0)
          ? 'Marker cleared — you can request again.'
          : 'Not cleared — the marker is under 10 minutes old; a request may be in flight.' }));
      }
      reloadPackable(); reloadShipments(); reload();
    } catch (e: unknown) {
      setRowMsg(m => ({ ...m, [s.id]: e instanceof Error ? e.message : 'Refund check failed' }));
    } finally {
      refundInFlight.current = false;
    }
  };

  const retryPushRow = async (s: ShipmentRow) => {
    // runPush does its own just-in-time packable read
    await runPush(s.id, Number(s.push_epoch || 0), s.carrier || '', s.tracking_number || '',
      s.items.map(i => ({ order_item_id: i.order_item_id, qty: String(i.qty), sku: i.sku_code })));
  };

  const drafts = shipments.filter(s => !s.finalized_at);
  const finals = shipments.filter(s => !!s.finalized_at);

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Ship — {order.order_number} · {order.customer_name}{testMode && <span className="ml-2 rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase align-middle">Shippo test mode</span>}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {/* ship-to, stated clearly — this is what goes on the label */}
          <div className="rounded border p-3 text-sm">
            <p className="text-xs font-semibold uppercase text-muted-foreground mb-1">Ship to</p>
            <p className="font-medium">{order.contact_name || order.customer_name}</p>
            <p>{order.address_line1}{order.address_line2 ? `, ${order.address_line2}` : ''}</p>
            <p>{order.city}, {order.state_code} {order.postal_code}</p>
            {(order.contact_phone || order.contact_email) && (
              <p className="text-xs text-muted-foreground mt-1">{[order.contact_phone, order.contact_email].filter(Boolean).join(' · ')}</p>
            )}
            {order.customer_note && <p className="text-xs text-amber-700 mt-1">“{order.customer_note}”</p>}
          </div>

          {/* items in the box */}
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Shipped</TableHead>
                  <TableHead className="text-right">Remaining</TableHead>
                  <TableHead className="w-28">This box</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {packLines.map(l => (
                  <TableRow key={l.order_item_id}>
                    <TableCell className="text-xs"><span className="font-medium">{l.sku_code}</span> <span className="text-muted-foreground">{l.product_name}</span></TableCell>
                    <TableCell className="text-right">{fmtNum(l.effective_qty)}</TableCell>
                    <TableCell className="text-right">{fmtNum(l.shipped_qty)}{Number(l.attributed_qty) > Number(l.shipped_qty) && <span className="block text-[10px] text-muted-foreground">+{fmtNum(Number(l.attributed_qty) - Number(l.shipped_qty))} in draft</span>}</TableCell>
                    <TableCell className="text-right font-medium">{fmtNum(l.remaining_qty)}</TableCell>
                    <TableCell>
                      <Input value={qtys[Number(l.order_item_id)] ?? ''} className="h-7 w-20 text-xs"
                        onChange={e => setQtys(q => ({ ...q, [Number(l.order_item_id)]: e.target.value }))} />
                    </TableCell>
                  </TableRow>
                ))}
                {directLines.map(l => (
                  <TableRow key={l.order_item_id} className="opacity-60">
                    <TableCell className="text-xs"><span className="font-medium">{l.sku_code}</span> <span className="rounded bg-violet-100 text-violet-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase ml-1">direct</span></TableCell>
                    <TableCell className="text-right">{fmtNum(l.effective_qty)}</TableCell>
                    <TableCell className="text-right text-xs" colSpan={3}>{l.direct_fulfilled_at ? 'vendor shipped' : 'vendor ships this line'}</TableCell>
                  </TableRow>
                ))}
                {digitalLines.map(l => (
                  <TableRow key={l.order_item_id} className="opacity-60">
                    <TableCell className="text-xs"><span className="font-medium">{l.sku_code}</span> <span className="rounded bg-sky-100 text-sky-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase ml-1">digital</span></TableCell>
                    <TableCell className="text-right">{fmtNum(l.effective_qty)}</TableCell>
                    <TableCell className="text-right text-xs" colSpan={3}>delivered digitally — not packed</TableCell>
                  </TableRow>
                ))}
                {packLines.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-4">Nothing left to pack on this order.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            {isPartial ? <span className="rounded bg-blue-100 text-blue-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase mr-1">partial</span> : <span className="rounded bg-green-100 text-green-800 text-[10px] font-semibold px-1.5 py-0.5 uppercase mr-1">full</span>}
            Defaults ship everything remaining; lower a quantity to split the order across boxes — the rest stays in the ready queue.
          </p>

          {/* box + ship-from */}
          <div className="flex flex-wrap gap-2 items-center">
            <Select value={shipFrom} onValueChange={setShipFrom}>
              <SelectTrigger className="h-9 w-56"><SelectValue placeholder="Ship from…" /></SelectTrigger>
              <SelectContent>
                {addresses.filter(a => a.active).map(a => <SelectItem key={a.id} value={String(a.id)}>{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {!manualMode && (
              <>
                <Input placeholder="L in" value={dims.length} onChange={e => setDims(d => ({ ...d, length: e.target.value }))} className="h-9 w-20" />
                <Input placeholder="W in" value={dims.width} onChange={e => setDims(d => ({ ...d, width: e.target.value }))} className="h-9 w-20" />
                <Input placeholder="H in" value={dims.height} onChange={e => setDims(d => ({ ...d, height: e.target.value }))} className="h-9 w-20" />
                <Input placeholder="Weight lb" value={weight} onChange={e => { setWeight(e.target.value); setWeightTouched(true); }} className="h-9 w-24" />
                {weightTouched && (
                  <button className="text-xs text-muted-foreground underline" onClick={() => { setWeightTouched(false); }}>recalc</button>
                )}
              </>
            )}
            <Input placeholder="Box (e.g. 8x6x4)" value={box} onChange={e => setBox(e.target.value)} className="h-9 w-28" />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground ml-auto">
              <input type="checkbox" checked={manualMode} onChange={e => setManualMode(e.target.checked)} />
              label bought outside the app
            </label>
          </div>
          {!manualMode && missingWeightSkus.length > 0 && (
            <p className="text-[11px] text-amber-700">No catalog weight for {missingWeightSkus.join(', ')} — they count as 0 in the prefill; adjust the weight by hand (set weights on the Products page).</p>
          )}
          {/* package photos: capture BEFORE shipping; they attach to the
              shipment record the moment it exists */}
          <div className="rounded border p-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Package photos</p>
              <Button size="sm" variant="outline" className="h-7 text-xs" disabled={photoBusy} onClick={() => capturePhotos('pending')}>
                {photoBusy ? 'Processing…' : '📷 Take / add photo'}
              </Button>
              <span className="text-[11px] text-muted-foreground">photograph the open box contents — saved with the shipment as evidence</span>
            </div>
            {pendingPhotos.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pendingPhotos.map((ph, i) => (
                  <span key={ph.key} className="relative">
                    <img src={ph.thumb} alt={`package photo ${i + 1}`}
                      className={`h-14 w-14 object-cover rounded border cursor-pointer ${ph.recovered ? 'ring-2 ring-amber-400' : ''}`}
                      title={ph.recovered ? 'Recovered from a failed or removed shipment — will NOT attach automatically' : undefined}
                      onClick={() => setViewPhoto(ph.full)} />
                    {ph.recovered && (
                      <button className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-amber-100 text-amber-900 border border-amber-400 px-1.5 text-[9px] leading-tight" title="Allow this photo to attach to the next shipment you create"
                        onClick={async () => { await stashUpsert({ ...ph, recovered: false }); refreshPendingView(); }}>use</button>
                    )}
                    <button className="absolute -top-1.5 -right-1.5 rounded-full bg-background border w-4 h-4 text-[10px] leading-none" title="Remove before shipping"
                      onClick={async () => { await stashRemove(ph.key); refreshPendingView(); }}>×</button>
                  </span>
                ))}
              </div>
            )}
            {photoMsg && <p className="text-[11px] text-amber-700">{photoMsg}</p>}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" capture="environment" multiple className="hidden"
            onChange={e => onFilesPicked(e.target.files)} />

          <Input placeholder="Note (optional)" value={note} onChange={e => setNote(e.target.value)} className="h-9" />

          {manualMode ? (
            <div className="flex flex-wrap gap-2 items-center">
              <Select value={mCarrier} onValueChange={setMCarrier}>
                <SelectTrigger className="h-9 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['usps', 'ups', 'fedex', 'dhl_express', 'dhl_ecommerce'].map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  <SelectItem value="other">other…</SelectItem>
                </SelectContent>
              </Select>
              {mCarrier === 'other' && <Input placeholder="carrier token" value={mCarrierOther} onChange={e => setMCarrierOther(e.target.value)} className="h-9 w-32" />}
              <Input placeholder="Tracking number" value={mTracking} onChange={e => setMTracking(e.target.value)} className="h-9 flex-1 min-w-52 font-mono text-xs" />
              <Input placeholder="Cost $ (optional)" value={mCost} onChange={e => setMCost(e.target.value)} className="h-9 w-32" />
              <Button size="sm" disabled={manualBusy} onClick={recordManual}>{manualBusy ? 'Recording…' : 'Record shipment'}</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2 items-center">
                <Button size="sm" variant="outline" disabled={ratesLoading} onClick={fetchRates}>{ratesLoading ? 'Quoting…' : 'Get rates'}</Button>
                {ratesResult && ratesResult.rates.length > 0 && pickedRate && (
                  <Button size="sm" disabled={purchasing} onClick={purchase}>
                    {purchasing ? 'Purchasing…' : `Buy label — ${fmtUSD(ratesResult.rates.find(r => r.object_id === pickedRate)?.amount || 0)}${testMode ? ' (TEST)' : ''}`}
                  </Button>
                )}
              </div>
              {ratesResult && ratesResult.messages.length > 0 && (
                <div className="text-[11px] text-amber-700 space-y-0.5">{ratesResult.messages.map((m, i) => <p key={i}>{m}</p>)}</div>
              )}
              {ratesResult && ratesResult.rates.length === 0 && (
                <p className="text-xs text-red-600">No UPS/USPS rates returned{ratesResult.allRateCount > 0 ? ` (${ratesResult.allRateCount} other-carrier rates were filtered)` : ''} — check the addresses above{ratesResult.allRateCount === 0 ? ' and that UPS/USPS are enabled on your Shippo account' : ''}.</p>
              )}
              {ratesResult && ratesResult.rates.length > 0 && (
                <div className="border rounded-lg overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow><TableHead className="w-8"></TableHead><TableHead>Carrier</TableHead><TableHead>Service</TableHead><TableHead className="text-right">Price</TableHead><TableHead className="text-right">Days</TableHead></TableRow>
                    </TableHeader>
                    <TableBody>
                      {ratesResult.rates.map(r => (
                        <TableRow key={r.object_id} className="cursor-pointer" onClick={() => setPickedRate(r.object_id)}>
                          <TableCell><input type="radio" readOnly checked={pickedRate === r.object_id} /></TableCell>
                          <TableCell>{r.provider}</TableCell>
                          <TableCell className="text-xs">{r.servicelevel?.name || r.servicelevel?.token || '—'}</TableCell>
                          <TableCell className="text-right font-medium">{fmtUSD(r.amount)}</TableCell>
                          <TableCell className="text-right text-xs">{r.estimated_days ?? '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}

          {msg && <p className="text-sm text-red-600">{msg}</p>}
          {purchaseMsg && <p className="text-sm text-red-600">{purchaseMsg}</p>}
          {success && (
            <div className="rounded border border-green-300 bg-green-50 p-2 text-sm space-y-1">
              <p className="font-medium text-green-900">Label purchased — tracking <span className="font-mono">{success.trackingNumber}</span></p>
              {success.labelUrl && <p className="text-xs"><a className="underline" href={success.labelUrl} target="_blank" rel="noreferrer">Open label (PDF)</a> <span className="text-muted-foreground">— public unauthenticated link, don't share</span></p>}
            </div>
          )}
          {manualSuccess && (
            <div className="rounded border border-green-300 bg-green-50 p-2 text-sm">
              <p className="font-medium text-green-900">Shipment recorded — tracking <span className="font-mono">{manualSuccess}</span> <span className="text-xs font-normal text-muted-foreground">(manual label — no in-app refund)</span></p>
            </div>
          )}
          {pushMsg && <p className={`text-sm ${pushMsg.startsWith('Pushed') ? 'text-green-700' : 'text-amber-700'}`}>{pushMsg}</p>}

          {/* existing shipments incl. drafts needing recovery */}
          {(drafts.length > 0 || finals.length > 0) && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase text-muted-foreground">Shipments on this order</p>
              {drafts.map(s => (
                <div key={s.id} className="rounded border border-amber-300 bg-amber-50 p-2 text-xs space-y-1">
                  <p className="font-medium text-amber-900">
                    DRAFT — {s.carrier} {s.servicelevel} {fmtUSD(s.rate_amount || 0)} · {(s.items || []).map(i => `${i.sku_code}×${fmtNum(i.qty)}`).join(', ')}
                    {s.purchase_attempted_at && !s.attempt_verified_no_label_at && <span className="ml-1 rounded bg-red-100 text-red-800 px-1.5 py-0.5 text-[10px] font-semibold uppercase">may hold a paid label</span>}
                  </p>
                  <div className="flex flex-wrap gap-1 items-center">
                    {pendingFinalize[s.id]
                      ? <Button size="sm" className="h-7 text-xs" onClick={() => retryFinalize(s)}>Retry save (label already purchased)</Button>
                      : <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => retryPurchase(s)}>Check Shippo & retry</Button>}
                    <Input placeholder="transaction id" value={recoverTxn[s.id] || ''} onChange={e => setRecoverTxn(m => ({ ...m, [s.id]: e.target.value }))} className="h-7 w-44 text-xs font-mono" />
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => recoverByTxn(s)}>Recover</Button>
                    {!pendingFinalize[s.id] && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600" onClick={() => deleteDraft(s)}>Delete draft</Button>
                    )}
                  </div>
                  {photos.filter(ph => Number(ph.shipment_id) === s.id).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {photos.filter(ph => Number(ph.shipment_id) === s.id).map(ph => (
                        <span key={ph.id} className="relative">
                          <img src={ph.thumb_data} alt="package photo" className="h-12 w-12 object-cover rounded border cursor-pointer" onClick={() => enlargePhoto(ph.id, s.id)} />
                          <button className="absolute -top-1.5 -right-1.5 rounded-full bg-background border w-4 h-4 text-[10px] leading-none" title="Remove photo (audited)"
                            onClick={() => removePhoto(ph.id, s.id)}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  {rowMsg[s.id] && <p className="text-red-700">{rowMsg[s.id]}</p>}
                </div>
              ))}
              {finals.map(s => (
                <div key={s.id} className={`rounded border p-2 text-xs space-y-1 ${s.refund_status === 'SUCCESS' ? 'opacity-60' : ''}`}>
                  <p className="flex flex-wrap items-center gap-1.5">
                    <StatusPill value={s.refund_status === 'SUCCESS' ? 'refunded' : s.status} />
                    <span className="font-mono">{(s.carrier || '').toUpperCase()} {s.tracking_number}</span>
                    <span className="text-muted-foreground">{(s.items || []).map(i => `${i.sku_code}×${fmtNum(i.qty)}`).join(', ')}</span>
                    <span className="text-muted-foreground">{fmtUSD(s.label_cost_usd)}</span>
                    {s.shipped_at && <span className="text-muted-foreground">{fmtDateTime(s.shipped_at)}</span>}
                    {s.refund_status && s.refund_status !== 'SUCCESS' && <span className="rounded bg-amber-100 text-amber-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase">refund {s.refund_status}</span>}
                    {!s.b44_pushed_at && s.refund_status !== 'SUCCESS' && <span className="rounded bg-amber-100 text-amber-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase" title="The ordering app has not been told about this shipment yet">not pushed</span>}
                  </p>
                  {photos.filter(ph => Number(ph.shipment_id) === s.id).length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {photos.filter(ph => Number(ph.shipment_id) === s.id).map(ph => (
                        <span key={ph.id} className="relative">
                          <img src={ph.thumb_data} alt="package photo" className="h-12 w-12 object-cover rounded border cursor-pointer" onClick={() => enlargePhoto(ph.id, s.id)} />
                          <button className="absolute -top-1.5 -right-1.5 rounded-full bg-background border w-4 h-4 text-[10px] leading-none" title="Remove photo (audited)"
                            onClick={() => removePhoto(ph.id, s.id)}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {s.label_url && <a className="underline text-muted-foreground" href={s.label_url} target="_blank" rel="noreferrer">label</a>}
                    {s.refund_status !== 'SUCCESS' && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={photoBusy} onClick={() => capturePhotos(s.id)}>+ photo</Button>
                    )}
                    {!s.b44_pushed_at && s.refund_status !== 'SUCCESS' && (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => retryPushRow(s)}>Push upstream</Button>
                    )}
                    {s.shippo_transaction_id && !s.refund_status && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-red-600" onClick={() => refund(s)}>Request refund</Button>
                    )}
                    {s.shippo_transaction_id && s.refund_status && s.refund_status !== 'SUCCESS' && (
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => recheckRefund(s)}>Re-check refund</Button>
                    )}
                  </div>
                  {rowMsg[s.id] && <p className="text-amber-800">{rowMsg[s.id]}</p>}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          </div>
        </div>
      </DialogContent>
      {viewPhoto && (
        <Dialog open onOpenChange={v => { if (!v) setViewPhoto(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Package photo</DialogTitle></DialogHeader>
            <img src={viewPhoto} alt="package photo (full size)" className="max-w-full max-h-[70vh] object-contain rounded" />
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
