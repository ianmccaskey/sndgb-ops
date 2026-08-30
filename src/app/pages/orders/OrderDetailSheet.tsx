import React, { useEffect, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getOrder from '@/actions/orders/getOrder';
import getOrderItems from '@/actions/orders/getOrderItems';
import listOrderPayments from '@/actions/payments/listOrderPayments';
import updateOrderAdmin from '@/actions/orders/updateOrderAdmin';
import addOverride from '@/actions/payments/addOverride';
import updatePaymentStatus from '@/actions/payments/updatePaymentStatus';
import addPaymentHash from '@/actions/payments/addPaymentHash';
import getOrderTxRefs from '@/actions/payments/getOrderTxRefs';
import addManualPaymentByNumber from '@/actions/payments/addManualPaymentByNumber';
import reopenPaymentOnNetwork from '@/actions/payments/reopenPaymentOnNetwork';
import undoPaymentRejection from '@/actions/payments/undoPaymentRejection';
import recordChainVerification from '@/actions/payments/recordChainVerification';
import { lookupTxPayment } from '@/lib/verifyPayment';
import setOrderItemComp from '@/actions/orders/setOrderItemComp';
import setOrderItemDirectShip from '@/actions/orders/setOrderItemDirectShip';
import markOrderDirectFulfilled from '@/actions/fulfillment/markOrderDirectFulfilled';
import listOrderShipments from '@/actions/fulfillment/listOrderShipments';
import listShipmentPhotos from '@/actions/fulfillment/listShipmentPhotos';
import getShipmentPhoto from '@/actions/fulfillment/getShipmentPhoto';
import addShipmentPhoto from '@/actions/fulfillment/addShipmentPhoto';
import { readStash, stashGet, stashRemove, stashMutateIf } from '@/lib/photoStash';
import type { StashedPhoto } from '@/lib/photoStash';
import getPackableItems from '@/actions/fulfillment/getPackableItems';
import markShipmentPushed from '@/actions/fulfillment/markShipmentPushed';
import { pushShipmentUpstream } from '@/lib/pushShipment';
import addLocalOrderItem from '@/actions/orders/addLocalOrderItem';
import setOrderFees from '@/actions/orders/setOrderFees';
import setOrderItemQty from '@/actions/orders/setOrderItemQty';
import removeOrderItem from '@/actions/orders/removeOrderItem';
import addOrderCredit from '@/actions/orders/addOrderCredit';
import deleteOrderCredit from '@/actions/orders/deleteOrderCredit';
import addOrderRefund from '@/actions/orders/addOrderRefund';
import deleteOrderRefund from '@/actions/orders/deleteOrderRefund';
import listOrderCredits from '@/actions/orders/listOrderCredits';
import listOrderRefunds from '@/actions/orders/listOrderRefunds';
import listWallets from '@/actions/financials/listWallets';
import deleteLocalOrderItem from '@/actions/orders/deleteLocalOrderItem';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import setOrderWriteoff from '@/actions/orders/setOrderWriteoff';
import updateOrderRail from '@/actions/orders/updateOrderRail';
import appendOrderAdminNote from '@/actions/orders/appendOrderAdminNote';
import { shortHash } from '@/lib/explorer';
import { B44_DEFAULT_APP_ID, getB44Order, updateB44Order } from '@/lib/base44';
import { normalizeTxHash, canonicalTxRef } from '@/lib/parseOrderImport';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { StatusPill } from '@/components/StatusPill';
import { TxHash } from '@/components/TxHash';

type OrderRow = {
  id: number; order_number: string; external_id: string | null; status: string; group_buy_id: number;
  payment_rail: string | null; contact_name: string | null; contact_email: string | null;
  contact_phone: string | null; discord_username: string | null;
  address_line1: string | null; address_line2: string | null; city: string | null;
  state_code: string | null; postal_code: string | null;
  subtotal_usd: string; tip_usd: string; admin_fee_usd: string; shipping_fee_usd: string;
  shipping_insurance_usd: string; processor_fee_usd: string; total_usd: string; placed_at: string | null;
  admin_fee_override_usd: string | null; shipping_fee_override_usd: string | null;
  shipping_insurance_override_usd: string | null; tip_override_usd: string | null;
  customer_note: string | null; admin_note: string | null; hold_shipping: boolean;
  customer_name: string; customer_email: string | null;
  recon_status: string | null; received_usd: string | null; override_usd: string | null;
  effective_received_usd: string | null; diff_usd: string | null;
  comp_usd: string | null; writeoff_usd: string | null; due_usd: string | null;
  split_fee_usd: string | null;
  credits_usd: string | null; refunds_usd: string | null;
  pending_payment_count: string | null;
};

type ItemRow = {
  id: number; qty: string; unit_price_usd: string; line_total_usd: string;
  comp_qty: string; comp_reason: string | null; comp_value_usd: string;
  direct_ship: boolean; direct_ship_source: string; direct_fulfilled_at: string | null;
  item_source: string; product_external_id: string | null;
  qty_override: string | null; removed_at: string | null; split_fee_usd: string;
  sku_code: string; product_name: string;
  // the label WE bought for this direct line (joined from the transfer
  // log through transfers.direct_order_item_id — never a copied value)
  direct_carrier: string | null; direct_tracking_number: string | null;
};
type PaymentRow = {
  id: number; method: string; tx_hash: string | null; receipt_ref: string | null;
  amount_usd: string; status: string; verify_source: string | null; verified_at: string | null; notes: string | null;
  native_amount: string | null; native_symbol: string | null; value_at_pay_usd: string | null;
};

export function OrderDetailSheet({ orderId, onClose }: { orderId: number | null; onClose: () => void }) {
  const { userName, settings, groupBuyId } = useApp();
  const open = orderId != null;
  const [rawOrder, , , reloadOrder] = useLoadAction(getOrder, [orderId], { order_id: orderId }, { enabled: open });
  const [rawItems, , , reloadItems] = useLoadAction(getOrderItems, [orderId], { order_id: orderId }, { enabled: open });
  const [rawPayments, , , reloadPayments] = useLoadAction(listOrderPayments, [orderId], { order_id: orderId }, { enabled: open });
  const [rawCampaignProducts] = useLoadAction(listCampaignProducts, [groupBuyId, open], { group_buy_id: groupBuyId }, { enabled: open && groupBuyId != null });
  const [rawCredits, , , reloadCredits] = useLoadAction(listOrderCredits, [orderId], { order_id: orderId }, { enabled: open });
  const [rawRefunds, , , reloadRefunds] = useLoadAction(listOrderRefunds, [orderId], { order_id: orderId }, { enabled: open });
  const [rawSheetWallets] = useLoadAction(listWallets, [open], {}, { enabled: open });
  const [rawShipRows, , , reloadShipRows] = useLoadAction(listOrderShipments, [orderId], { order_id: orderId }, { enabled: open });
  const [rawShipPhotos, , , reloadShipPhotos] = useLoadAction(listShipmentPhotos, [orderId], { order_id: orderId }, { enabled: open });
  const shipPhotos = rows<{ id: number; shipment_id: number; thumb_data: string }>(rawShipPhotos);
  const [viewShipPhoto, setViewShipPhoto] = useState<string | null>(null);
  const [doGetShipPhoto] = useMutateAction(getShipmentPhoto);
  // list rows carry thumbnails only; the full image loads on demand
  const enlargeShipPhoto = async (photoId: number, shipmentId: number) => {
    try {
      const res = await doGetShipPhoto({ photo_id: photoId, shipment_id: shipmentId }) as { image_data?: string }[] | null;
      const row = Array.isArray(res) && res.length > 0 ? res[0] : null;
      if (row?.image_data) setViewShipPhoto(String(row.image_data));
    } catch { /* thumbnail stays; nothing to show */ }
  };
  // stranded-photo recovery: package captures saved on THIS DEVICE whose
  // upload never verified. The ship dialog auto-replays them, but a fully
  // shipped order may never open that dialog again — this sheet is
  // reachable forever, so the recovery surface lives here too. Bound
  // entries replay against their original shipment; unbound (recovered)
  // ones attach to the newest live shipment on explicit click.
  const [doAddShipPhoto] = useMutateAction(addShipmentPhoto);
  // read action invoked imperatively (getOrderTxRefs precedent): the
  // attach target must come from a JUST-IN-TIME authoritative read at
  // click time — another admin may have created or voided boxes since
  // the sheet's rows rendered
  const [fetchShipRowsJit] = useMutateAction(listOrderShipments);
  const [stranded, setStranded] = useState<StashedPhoto[]>([]);
  const [strandedMsg, setStrandedMsg] = useState('');
  // explicit attach target per recovered photo (stash key -> shipment id
  // as string; '' = default newest finalized box). Validated against a
  // fresh JIT read at click time.
  const [attachTarget, setAttachTarget] = useState<Record<string, string>>({});
  const refreshStranded = async () => {
    if (orderId == null) { setStranded([]); return; }
    const { photos, readOk } = await readStash(orderId);
    // every entry for the order is VISIBLE here (a fully shipped order
    // may never reopen the ship dialog, and photos must not be orphaned
    // invisibly) — but an ordinary unbound pending capture is not
    // attachable from this surface until the operator explicitly
    // "recover"s it: fresh captures belong to the ship dialog's next box,
    // never implicitly to an older one
    setStranded(photos.filter(s => s.order_id === orderId));
    if (!readOk) setStrandedMsg('Warning: saved photos on this device could not be read — this list may be incomplete. Reload the page to retry.');
  };
  useEffect(() => { if (open) { setStrandedMsg(''); refreshStranded(); } // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId]);
  const retryStranded = async (s: StashedPhoto) => {
    // re-read first: another tab may have discarded, attached, or
    // reclassified this entry since the list rendered — never act on a
    // stale snapshot
    const cur = await stashGet(s.key);
    if (!cur) { setStrandedMsg('This photo was already handled (attached or discarded) in another tab.'); refreshStranded(); return; }
    if (cur.shipment_id !== s.shipment_id || !!cur.recovered !== !!s.recovered) {
      setStrandedMsg('This photo changed in another tab — the list has been refreshed; try again.');
      refreshStranded();
      return;
    }
    const wasBound = s.shipment_id != null;
    let target = s.shipment_id;
    if (target == null) {
      // resolve the target fresh, never from cached rows; prefer a
      // FINALIZED box over a draft (a deleted draft would leave the photo
      // only in audit tombstones), and NEVER attach silently — the
      // operator confirms the exact shipment the evidence will join
      try {
        type JitRow = { id: number; refund_status: string | null; finalized_at: string | null; carrier: string | null; tracking_number: string | number | null };
        const res = await fetchShipRowsJit({ order_id: orderId }) as JitRow[] | null;
        const live = (Array.isArray(res) ? res : []).filter(r => r.refund_status !== 'SUCCESS');
        // the operator's explicit pick wins; it must still exist LIVE in
        // the fresh read. No pick = newest finalized box (drafts only
        // when nothing finalized exists).
        const pickedId = attachTarget[s.key] ? Number(attachTarget[s.key]) : null;
        let chosen: JitRow | null = null;
        if (pickedId != null) {
          chosen = live.find(r => Number(r.id) === pickedId) ?? null;
          if (!chosen) { setStrandedMsg('The selected shipment is no longer live — the list has been refreshed; choose again.'); refreshStranded(); return; }
        } else {
          const pool = live.filter(r => r.finalized_at != null);
          chosen = (pool.length > 0 ? pool : live).reduce<JitRow | null>((acc, r) => (acc == null || Number(r.id) > Number(acc.id) ? r : acc), null);
        }
        if (!chosen) { setStrandedMsg('No live shipment to attach to — ship a box from the Fulfillment page first, or remove the photo.'); return; }
        const label = `#${chosen.id}${chosen.finalized_at ? '' : ' (unfinished draft)'}${chosen.carrier ? ` ${String(chosen.carrier).toUpperCase()}` : ''}${chosen.tracking_number ? ` ${String(chosen.tracking_number)}` : ''}`;
        if (!window.confirm(`Attach this photo to shipment ${label}? It becomes part of that box's evidence.`)) return;
        target = Number(chosen.id);
      } catch { setStrandedMsg('Could not load this order’s shipments — try again.'); return; }
    }
    // bind FIRST via CAS, before any network work: a committed insert
    // with a lost response must replay against THIS shipment later, never
    // migrate to a different "newest" box. The CAS applies only if the
    // entry still matches the state we just observed — a tab that changed
    // it in the microseconds since wins, and we abort.
    const preState = { shipment_id: s.shipment_id, recovered: !!s.recovered };
    const bindRes = await stashMutateIf(s.key, preState, { ...s, shipment_id: target });
    if (!bindRes.ok) {
      setStrandedMsg('This photo could not be updated safely (it changed in another tab, or this device’s storage is unavailable) — the list has been refreshed; try again.');
      refreshStranded();
      return;
    }
    const boundDurable = bindRes.durable; // false = page-lifetime only
    const boundState = { shipment_id: target, recovered: !!s.recovered };
    try {
      // a bound entry is an automatic replay (the insert may have already
      // committed); an unbound attach here is a deliberate operator act
      const res = await doAddShipPhoto({ shipment_id: target, image_data: s.full, thumb_data: s.thumb, actor: s.actor || userName, replay: wasBound }) as unknown[] | null;
      const ok = Array.isArray(res) ? res.length > 0 : !!res;
      if (ok) {
        const del = await stashMutateIf(s.key, boundState, null);
        // a non-durable removal (storage unavailable) is harmless: the
        // server's same-content dedupe recognizes a re-offer of this
        // photo and returns the existing row instead of duplicating
        setStrandedMsg(del.ok && del.durable ? 'Photo attached.' : 'Photo attached. (This device’s storage is unavailable, so it may be re-offered after a reload — re-attaching is harmless; the server recognizes it.)');
        reloadShipPhotos();
      }
      else if (wasBound) {
        // the original shipment refuses replay (deleted, voided, quota, or
        // the photo was deliberately removed) — mirror the ship dialog:
        // the entry becomes unbound + recovered, so "Attach" to a live
        // shipment is offered instead of retrying a dead one forever
        const rec = await stashMutateIf(s.key, boundState, { ...s, shipment_id: null, recovered: true });
        setStrandedMsg('Its original shipment refused this photo (deleted, voided, quota full, or it was removed on purpose) — it is now attachable: use "Attach" to put it on the newest live shipment, or discard it.'
          + (rec.ok && rec.durable ? '' : ' Warning: this device’s storage is unavailable — it survives only while this page stays open.'));
      } else {
        // roll the pre-upload bind BACK: a refused DELIBERATE attach must
        // stay an operator-driven Attach — left bound, a later automatic
        // retry would run with replay semantics against a box the
        // operator never confirmed
        const rb = await stashMutateIf(s.key, boundState, { ...s, shipment_id: null, recovered: true });
        setStrandedMsg('The shipment refused this photo (quota full, voided, already on another box of this order, or previously removed on purpose) — remove it here if it is no longer needed.'
          + (rb.ok && rb.durable ? '' : ' Warning: this device’s storage is unavailable — it survives only while this page stays open.'));
      }
    } catch {
      setStrandedMsg(boundDurable
        ? 'Upload failed — the photo stays saved on this device; retry.'
        : 'Upload failed AND this device’s storage is unavailable — the photo survives only while this page stays open. Retry now or re-take it.');
    }
    refreshStranded();
  };
  const o = firstRow<OrderRow>(rawOrder);
  const items = rows<ItemRow>(rawItems);
  const campaignProducts = rows<{ sku_code: string; gb_price_usd: string; status: string }>(rawCampaignProducts)
    .filter(p => p.status === 'active');
  const feeDeltaUsd = o
    ? (Number(o.admin_fee_override_usd ?? o.admin_fee_usd) - Number(o.admin_fee_usd))
      + (Number(o.shipping_fee_override_usd ?? o.shipping_fee_usd) - Number(o.shipping_fee_usd))
      + (Number(o.shipping_insurance_override_usd ?? o.shipping_insurance_usd) - Number(o.shipping_insurance_usd))
      + (Number(o.tip_override_usd ?? o.tip_usd) - Number(o.tip_usd))
    : 0;
  const effQty = (i: ItemRow) => i.removed_at ? 0 : Number(i.qty_override ?? i.qty);
  const localItemsUsd = Math.round(items.filter(i => i.item_source === 'local')
    .reduce((s, i) => s + effQty(i) * Number(i.unit_price_usd), 0) * 100) / 100;
  // imported rows: billed delta from qty edits / removals (negative when
  // reduced). A removed line also releases its charged split fee — same
  // term as v_order_reconciliation's item delta and the push math, so the
  // displayed Expected total never diverges from billed.
  const itemDeltaUsd = Math.round(items.filter(i => i.item_source === 'import')
    .reduce((s, i) => s + (effQty(i) - Number(i.qty)) * Number(i.unit_price_usd)
      - (i.removed_at ? Number(i.split_fee_usd || 0) : 0), 0) * 100) / 100;
  const payments = rows<PaymentRow>(rawPayments);
  type ShipRow = {
    id: number; status: string; carrier: string | null; tracking_number: string | null;
    label_cost_usd: string; label_url: string | null; from_label: string | null;
    refund_status: string | null; finalized_at: string | null; shipped_at: string | null;
    b44_pushed_at: string | null; push_epoch: number; created_by: string | null;
    items: { order_item_id: number; qty: string; sku_code: string }[];
  };
  type ShipPackableRow = {
    order_item_id: number; product_external_id: string | null; sku_code: string;
    effective_qty: string; shipped_qty: string; direct_ship: boolean; direct_fulfilled_at: string | null;
    digital: boolean;
  };
  const shipRows = rows<ShipRow>(rawShipRows).map(s => ({ ...s, tracking_number: s.tracking_number == null ? null : String(s.tracking_number) }));

  const [doUpdate] = useMutateAction(updateOrderAdmin);
  const [doOverride] = useMutateAction(addOverride);
  const [doPayStatus] = useMutateAction(updatePaymentStatus);
  const [doAddHash] = useMutateAction(addPaymentHash);
  const [doGetTxRefs] = useMutateAction(getOrderTxRefs);
  const [doAppendNote] = useMutateAction(appendOrderAdminNote);
  const [doMarkShipPushed] = useMutateAction(markShipmentPushed);
  // read action invoked imperatively (getOrderTxRefs precedent): the push's
  // fully-shipped decision needs a JUST-IN-TIME authoritative read
  const [doFetchShipPackable] = useMutateAction(getPackableItems);
  const [shipPushMsg, setShipPushMsg] = useState('');
  const shipPushInFlight = React.useRef(false);

  // retry the ordering-app push for one shipped box (the fulfillment modal
  // pushes automatically; this covers failed pushes and the direct-line-
  // last case where no shipment row changed). Packable rows are fetched
  // FRESH here — never from sheet-open hook state — because they decide
  // whether the upstream order advances to 'shipped'.
  const pushShipRow = async (s: { id: number; push_epoch: number; carrier: string | null; tracking_number: string | null; items: { order_item_id: number; qty: string; sku_code: string }[] }) => {
    if (!o || shipPushInFlight.current) return;
    shipPushInFlight.current = true;
    setShipPushMsg('Pushing to the ordering app…');
    try {
      let fresh: ShipPackableRow[];
      try {
        const res = await doFetchShipPackable({ order_id: o.id }) as unknown[] | null;
        fresh = (Array.isArray(res) ? res : []) as ShipPackableRow[];
        if (fresh.length === 0) throw new Error('empty read');
      } catch {
        setShipPushMsg('Push not sent — could not re-read the order\'s packing state. Retry.');
        return;
      }
      const out = await pushShipmentUpstream({
        cfg: { appId: settings.base44_app_id || B44_DEFAULT_APP_ID, token: settings.base44_token || '' },
        externalId: o.external_id || '', orderId: o.id, orderNumber: o.order_number,
        shipmentId: s.id, pushEpoch: Number(s.push_epoch || 0), carrier: s.carrier || '', tracking: s.tracking_number || '',
        shippedItems: (s.items || []).map(i => ({ sku: i.sku_code, qty: String(i.qty) })),
        packable: fresh.map(l => ({
          order_item_id: Number(l.order_item_id),
          product_external_id: l.product_external_id == null ? null : String(l.product_external_id),
          sku_code: l.sku_code, effective_qty: String(l.effective_qty), shipped_qty: String(l.shipped_qty),
          direct_ship: l.direct_ship, direct_fulfilled_at: l.direct_fulfilled_at, digital: l.digital,
        })),
        userName, appendNote: doAppendNote, markPushed: doMarkShipPushed,
      });
      setShipPushMsg(out.message);
      reloadShipRows(); reloadOrder();
    } finally {
      shipPushInFlight.current = false;
    }
  };
  const [doCashPay] = useMutateAction(addManualPaymentByNumber);
  const [doReopenNetwork] = useMutateAction(reopenPaymentOnNetwork);
  const [doUndoRejection] = useMutateAction(undoPaymentRejection);
  const [doRecordVerification] = useMutateAction(recordChainVerification);
  const [doSetComp] = useMutateAction(setOrderItemComp);
  const [doSetDirectShip] = useMutateAction(setOrderItemDirectShip);
  const [doMarkDirectFulfilled] = useMutateAction(markOrderDirectFulfilled);
  const [doAddLocalItem] = useMutateAction(addLocalOrderItem);
  const [doSetFees] = useMutateAction(setOrderFees);
  const [doSetItemQty] = useMutateAction(setOrderItemQty);
  const [doRemoveItem] = useMutateAction(removeOrderItem);
  const [fetchFreshOrder] = useMutateAction(getOrder);
  const [fetchFreshItems] = useMutateAction(getOrderItems);
  const [doAddCredit] = useMutateAction(addOrderCredit);
  const [doDelCredit] = useMutateAction(deleteOrderCredit);
  const [doAddRefund] = useMutateAction(addOrderRefund);
  const [doDelRefund] = useMutateAction(deleteOrderRefund);
  const [doDeleteLocalItem] = useMutateAction(deleteLocalOrderItem);
  const [doSetWriteoff] = useMutateAction(setOrderWriteoff);
  const [doUpdateRail] = useMutateAction(updateOrderRail);

  const [status, setStatus] = useState('imported');
  const [hold, setHold] = useState(false);
  const [adminNote, setAdminNote] = useState('');
  const [overrideAmt, setOverrideAmt] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // cash / P2P payment recording (right where the recon click lands)
  const [cashAmt, setCashAmt] = useState('');
  const [cashMethod, setCashMethod] = useState('zelle');
  const [cashRef, setCashRef] = useState('');
  const [cashMsg, setCashMsg] = useState('');

  // rail correction (order says ETH, money verified on SOL)
  const [railMsg, setRailMsg] = useState('');

  // write-off (forgive a small residual shortfall)
  const [woEditing, setWoEditing] = useState(false);
  const [woAmt, setWoAmt] = useState('');
  const [woReason, setWoReason] = useState('');
  const [woMsg, setWoMsg] = useState('');

  // comped (free) items
  const [compingId, setCompingId] = useState<number | null>(null);
  const [addSku, setAddSku] = useState('');
  const [addQty, setAddQty] = useState('');
  const [addMsg, setAddMsg] = useState('');
  const [qtyEditId, setQtyEditId] = useState<number | null>(null);
  const [qtyEditVal, setQtyEditVal] = useState('');
  const [addingCredit, setAddingCredit] = useState(false);
  const [creditAmt, setCreditAmt] = useState('');
  const [creditReason, setCreditReason] = useState('');
  const [addingRefund, setAddingRefund] = useState(false);
  const [refundAmt, setRefundAmt] = useState('');
  const [refundMethod, setRefundMethod] = useState('eth');
  const [refundWallet, setRefundWallet] = useState('');
  const [refundTxRef, setRefundTxRef] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [crMsg, setCrMsg] = useState('');
  const [editingFees, setEditingFees] = useState(false);
  const [feeAdmin, setFeeAdmin] = useState('');
  const [feeShipping, setFeeShipping] = useState('');
  const [feeInsurance, setFeeInsurance] = useState('');
  const [feeTip, setFeeTip] = useState('');
  const [feeMsg, setFeeMsg] = useState('');
  const [compQty, setCompQty] = useState('');
  const [compReason, setCompReason] = useState('');
  const [compMsg, setCompMsg] = useState('');

  // payment corrections
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [undoingId, setUndoingId] = useState<number | null>(null);
  const [undoReason, setUndoReason] = useState('');
  const [newHash, setNewHash] = useState('');
  const [newHashMethod, setNewHashMethod] = useState('eth');
  const [payMsg, setPayMsg] = useState('');
  const [pushMsg, setPushMsg] = useState('');
  const [pushing, setPushing] = useState(false);

  useEffect(() => {
    if (o) {
      setStatus(o.status);
      setHold(!!o.hold_shipping);
      setAdminNote(o.admin_note || '');
      setOverrideAmt('');
      setOverrideReason('');
      setError('');
      setRejectingId(null); setRejectReason('');
      setUndoingId(null); setUndoReason('');
      setNewHash(''); setPayMsg(''); setPushMsg('');
      setNewHashMethod(o.payment_rail === 'sol' || o.payment_rail === 'base' ? o.payment_rail : 'eth');
      setCashAmt(''); setCashRef(''); setCashMsg('');
      setCashMethod(o.payment_rail === 'cash' ? 'zelle' : 'other');
      setCompingId(null); setCompQty(''); setCompReason(''); setCompMsg('');
      setWoEditing(false); setWoAmt(''); setWoReason(''); setWoMsg('');
      setRailMsg('');
    }
  }, [o?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Right hash, wrong network": a rejected tx-hash payment can be re-opened
  // as pending on the network its hash format actually belongs to. addHash
  // deliberately refuses re-adding a same-order rejected hash, so this
  // explicit path is the correction route. Targets are derived from the hash
  // format — an 0x hash can only re-open on eth/base, base58 only on sol —
  // minus the network it was already rejected under.
  const reopenTargets = (p: PaymentRow): string[] => {
    const h = (p.tx_hash || '').trim();
    if (!h) return [];
    const plausible = /^0x[0-9a-fA-F]{64}$/.test(h) ? ['eth', 'base']
      : /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(h) ? ['sol'] : [];
    return plausible.filter(m => m !== p.method);
  };

  // Inline on-chain verification — same lookup + same write-if-still-pending
  // action as the Reconciliation page, so a hash just added (or re-opened)
  // can be confirmed without leaving the order.
  const verifyNow = async (p: PaymentRow) => {
    if (!o || !p.tx_hash) return;
    setSaving(true); setPayMsg('');
    try {
      const res = await lookupTxPayment(p.method, p.tx_hash, settings);
      // Native-token payments without a USD value become mismatch so someone
      // prices them; stablecoin payments verify at face value — order-level
      // recon decides matched/short/over.
      const status = res.amountUsd > 0 ? 'verified' : 'mismatch';
      const recorded = await doRecordVerification({
        payment_id: p.id,
        amount_usd: res.amountUsd,
        native_amount: res.nativeAmount != null ? String(res.nativeAmount) : '',
        native_symbol: res.nativeSymbol || '',
        value_at_pay_usd: '',
        status,
        notes: res.note,
        actor: userName,
      }) as unknown[] | null;
      // Zero rows = the payment stopped being pending mid-lookup (e.g. it was
      // rejected in another tab) — the stale result was NOT written.
      const wrote = Array.isArray(recorded) ? recorded.length > 0 : !!recorded;
      const nativeOnly = res.amountUsd === 0 && res.nativeAmount != null && res.nativeAmount > 0;
      setPayMsg(!wrote ? 'Skipped — the payment is no longer pending.'
        : nativeOnly ? `Native ${res.nativeAmount} ${res.nativeSymbol} found — needs USD pricing; set an order override below to count it.`
        : `Verified on-chain: ${fmtUSD(res.amountUsd)}.`);
      reloadPayments(); reloadOrder();
    } catch (e: unknown) {
      setPayMsg(e instanceof Error ? e.message : 'Verification failed');
    } finally {
      setSaving(false);
    }
  };

  // Undo a MISTAKEN rejection (same network — the reopen buttons only offer
  // different ones). Explicit and audited: a reason is required, and the
  // payment goes back to pending to re-earn verification on-chain.
  const undoRejection = async (p: PaymentRow) => {
    if (!o) return;
    if (!undoReason.trim()) { setPayMsg('A reason is required — why was the rejection wrong? (audited)'); return; }
    setSaving(true); setPayMsg('');
    try {
      const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
      const res = await doUndoRejection({
        payment_id: p.id, order_id: o.id, reason: undoReason.trim(), actor: userName,
        note: `${ts} rejection undone (${undoReason.trim()}) — back to pending for on-chain verification.`,
      }) as { reopened: string }[] | { reopened: string };
      const reopened = Number(Array.isArray(res) ? res[0]?.reopened : res?.reopened);
      if (!reopened) {
        setPayMsg('Could not undo — the hash may now live on another non-rejected payment.');
      } else {
        setPayMsg('Rejection undone — the payment is pending again; click Verify next to it.');
        setUndoingId(null); setUndoReason('');
      }
      reloadPayments(); reloadOrder();
    } catch (e: unknown) {
      setPayMsg(e instanceof Error ? e.message : 'Failed to undo rejection');
    } finally {
      setSaving(false);
    }
  };

  const reopenOnNetwork = async (p: PaymentRow, method: string) => {
    if (!o) return;
    setSaving(true); setPayMsg('');
    try {
      const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
      const res = await doReopenNetwork({
        payment_id: p.id, order_id: o.id, method,
        note: `${ts} re-opened as pending on ${method.toUpperCase()}: hash was recorded under the wrong network (${p.method}).`,
        actor: userName,
      }) as { reopened: string }[] | { reopened: string };
      const reopened = Number(Array.isArray(res) ? res[0]?.reopened : res?.reopened);
      if (!reopened) {
        setPayMsg('Could not re-open — the hash may already live on another non-rejected payment, or its format does not match that network.');
      } else {
        setPayMsg(`Re-opened as pending on ${method.toUpperCase()} — click Verify next to it to confirm on-chain.`);
      }
      reloadPayments(); reloadOrder();
    } catch (e: unknown) {
      setPayMsg(e instanceof Error ? e.message : 'Failed to re-open payment');
    } finally {
      setSaving(false);
    }
  };

  // Rail correction: pushTxRefs only syncs the HASH LIST, so when a payment
  // is re-opened on the right network the push correctly reports "already
  // matches" — what's wrong upstream is the order's payment_method field.
  // These are the exact strings the ordering app uses today (observed across
  // all imported orders); BASE has no known upstream value, so a base
  // correction applies locally only.
  const UPSTREAM_METHOD: Record<string, string> = { sol: 'usdc_sol', eth: 'paige-usdc-eth' };

  // Offered only when the evidence is unambiguous: every VERIFIED tx-hash
  // payment sits on one single network and it isn't the order's rail.
  const verifiedTxMethods = [...new Set(payments.filter(p => p.status === 'verified' && p.tx_hash).map(p => p.method))];
  const railMismatch = o && ['eth', 'sol', 'base'].includes(o.payment_rail || '')
    && verifiedTxMethods.length === 1 && verifiedTxMethods[0] !== o.payment_rail
    ? verifiedTxMethods[0] : null;

  const correctRail = async (newRail: string) => {
    if (!o) return;
    setSaving(true); setRailMsg('');
    try {
      const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
      const upstreamValue = UPSTREAM_METHOD[newRail];
      // No known upstream representation (BASE today): a local-only change
      // would be silently reverted by the next import, so refuse instead of
      // pretending. The UI never offers the button in this case; this is the
      // backstop.
      if (!o.external_id || !upstreamValue) {
        setRailMsg('This correction cannot be pushed to the ordering app (no upstream value for that network) — a local-only change would be reverted by the next import.');
        return;
      }
      // LOCAL FIRST: updateOrderRail re-proves the evidence against fresh
      // database state (expected rail + exactly-one verified network =
      // target) inside its transaction. Nothing touches the ordering app on
      // stale render-time evidence — a no-row refusal is a hard stop with
      // zero changes anywhere.
      // Every local note write below must also patch the admin-note editor
      // state — the editor only rehydrates on order change, and a later
      // Admin Save with stale text would overwrite the appended trail.
      const syncNote = (line: string, written?: string | null) => {
        setAdminNote(prev => written ?? (prev ? `${prev}\n${line}` : line));
      };

      const localLine = `${ts} payment rail corrected ${o.payment_rail} → ${newRail}: payment verified on ${newRail.toUpperCase()}.`;
      const res = await doUpdateRail({
        order_id: o.id, rail: newRail, expected_rail: o.payment_rail, actor: userName,
        note: localLine,
      }) as { admin_note: string | null }[] | { admin_note: string | null } | null;
      const wrote = Array.isArray(res) ? res.length > 0 : !!res;
      if (wrote) {
        const writtenNote = Array.isArray(res) ? res[0]?.admin_note : res?.admin_note;
        syncNote(localLine, writtenNote);
      }
      if (!wrote) {
        setRailMsg('Nothing changed — the order or its payments were modified since you opened it. Re-open the order and check.');
        reloadOrder();
        return;
      }

      // Then push upstream. If this fails, local and upstream disagree — but
      // that state self-heals: the next import copies the (still wrong)
      // upstream payment_method back over the local rail, the mismatch box
      // reappears, and the operator retries the whole correction.
      const cfg = { appId: settings.base44_app_id || B44_DEFAULT_APP_ID, token: settings.base44_token || '' };
      // Read-check-write: a retry must not push (or note) the same
      // correction twice if upstream already matches. The read itself can
      // fail (expired token, network) with the local rail already committed —
      // that must leave a trail line too, not just a thrown error, so the
      // whole upstream phase reports through the same failure path.
      let b44;
      try {
        b44 = await getB44Order(cfg, o.external_id);
      } catch (readErr: unknown) {
        const skipLine = `${ts} upstream payment_method push SKIPPED — could not read the ordering app (${readErr instanceof Error ? readErr.message : 'unknown error'}); nothing was changed upstream. Local rail is corrected; the next import will revert it and re-offer this correction.`;
        let skipNoted = false;
        try {
          const skipRes = await doAppendNote({ order_id: o.id, note: skipLine, actor: userName, detail: JSON.stringify({ rail_push_skipped: true }) }) as { admin_note: string }[] | { admin_note: string };
          syncNote(skipLine, Array.isArray(skipRes) ? skipRes[0]?.admin_note : skipRes?.admin_note);
          skipNoted = true;
        } catch { /* surfaced in the message below */ }
        setRailMsg(skipNoted
          ? 'Local rail corrected, but the ordering app could not be reached — nothing was pushed. The next import will revert the local rail and re-offer this correction; retry then.'
          : 'Local rail corrected, but the ordering app could not be reached AND the audit note failed to write — record this manually in the admin notes. The next import will revert the local rail and re-offer this correction; retry then.');
        reloadOrder();
        return;
      }
      if (String(b44.payment_method || '') !== upstreamValue) {
        // Local trail BEFORE the upstream mutation — standing rule for
        // anything that changes the ordering app.
        const pushingLine = `${ts} pushing payment_method correction to the ordering app: ${upstreamValue} (${newRail.toUpperCase()}).`;
        const pushingRes = await doAppendNote({
          order_id: o.id,
          note: pushingLine,
          actor: userName,
          detail: JSON.stringify({ rail_push: true, from: b44.payment_method || null, to: upstreamValue }),
        }) as { admin_note: string }[] | { admin_note: string };
        syncNote(pushingLine, Array.isArray(pushingRes) ? pushingRes[0]?.admin_note : pushingRes?.admin_note);
        const line = `${ts} payment method corrected to ${upstreamValue} (${newRail.toUpperCase()}) by SND GB Ops — customer paid on ${newRail.toUpperCase()}.`;
        try {
          await updateB44Order(cfg, o.external_id, {
            payment_method: upstreamValue,
            notes: b44.notes ? `${b44.notes}\n${line}` : line,
          });
        } catch (pushErr: unknown) {
          // The trail must state the ACTUAL outcome of the attempt, not
          // just that one started — verify the FULL intended postcondition
          // (method AND the mirrored note). A matching method alone could
          // be a partial apply or someone else's concurrent fix; treating
          // that as landed would over-claim in both audit trails.
          let landed = false;
          let outcome = 'outcome UNKNOWN — check the ordering app before retrying';
          try {
            const after = await getB44Order(cfg, o.external_id);
            const methodOk = String(after.payment_method || '') === upstreamValue;
            const noteOk = String(after.notes || '').includes(line);
            landed = methodOk && noteOk;
            outcome = landed ? 'it LANDED upstream (method + note) despite the error'
              : methodOk ? 'PARTIAL: upstream payment_method matches but the correction note is missing — verify who changed it and add the note upstream manually'
              : 'upstream is unchanged';
          } catch { /* keep UNKNOWN */ }
          const failLine = `${ts} payment_method push error (${pushErr instanceof Error ? pushErr.message : 'unknown error'}) — ${outcome}.`;
          let failNoted = false;
          try {
            const failRes = await doAppendNote({ order_id: o.id, note: failLine, actor: userName, detail: JSON.stringify({ rail_push_error: true, landed }) }) as { admin_note: string }[] | { admin_note: string };
            syncNote(failLine, Array.isArray(failRes) ? failRes[0]?.admin_note : failRes?.admin_note);
            failNoted = true;
          } catch { /* surfaced in the message below */ }
          if (!landed) {
            setRailMsg(`Local rail corrected, but the ordering app push failed (${outcome}).${failNoted ? '' : ' The audit note ALSO failed to write — record this manually in the admin notes.'} The next import will revert the local rail and re-offer this correction — retry then.`);
            reloadOrder();
            return;
          }
        }
      }
      setRailMsg(`Rail corrected to ${newRail.toUpperCase()} and pushed to the ordering app.`);
      reloadOrder();
    } catch (e: unknown) {
      setRailMsg(e instanceof Error ? e.message : 'Failed to correct rail');
    } finally {
      setSaving(false);
    }
  };

  // Write-off: forgive a small residual shortfall (fee dust, rounding, a
  // few dollars short). The SQL caps the amount at the order's CURRENT
  // shortfall in-transaction, so a write-off can never exceed what's
  // actually missing; the value stays tracked in recon and P&L.
  const saveWriteoff = async (amountStr: string, reason: string) => {
    if (!o) return;
    const clearing = Number(amountStr) === 0;
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountStr.trim())) { setWoMsg('Amount must be a number with at most 2 decimals.'); return; }
    if (!clearing && !reason.trim()) { setWoMsg('A reason is required — write-offs are audited money.'); return; }
    setSaving(true); setWoMsg('');
    try {
      const res = await doSetWriteoff({
        order_id: o.id, amount: amountStr.trim(), reason: reason.trim(), actor: userName,
      }) as { written: string }[] | { written: string };
      const written = Number(Array.isArray(res) ? res[0]?.written : res?.written);
      if (!written) {
        setWoMsg(clearing ? 'Nothing to clear.' : 'Refused — the amount exceeds what the order is actually short (or the reason is missing).');
      } else {
        setWoEditing(false); setWoAmt(''); setWoReason('');
      }
      reloadOrder();
    } catch (e: unknown) {
      setWoMsg(e instanceof Error ? e.message : 'Failed to save write-off');
    } finally {
      setSaving(false);
    }
  };

  // Comp (free product) on one line: recon then owes billed − comp value,
  // and P&L books the give-away. Validation mirrors the SQL guards so the
  // refusal message is immediate instead of a silent no-row result.
  const saveComp = async (it: ItemRow, qtyStr: string, reason: string) => {
    if (!o) return;
    const clearing = Number(qtyStr) === 0;
    if (!/^\d+(?:\.\d{1,2})?$/.test(qtyStr.trim())) { setCompMsg('Comp qty must be a number with at most 2 decimals.'); return; }
    if (Number(qtyStr) > effQty(it)) { setCompMsg(`Can't comp more than the ${effQty(it)} the customer is getting.`); return; }
    if (!clearing && !reason.trim()) { setCompMsg('A reason is required — comps are audited money.'); return; }
    setSaving(true); setCompMsg('');
    try {
      const res = await doSetComp({
        item_id: it.id, order_id: o.id, comp_qty: qtyStr.trim(), reason: reason.trim(), actor: userName,
      }) as unknown[] | null;
      const wrote = Array.isArray(res) ? res.length > 0 : !!res;
      if (!wrote) { setCompMsg('Comp refused — check the quantity and reason.'); }
      else { setCompingId(null); setCompQty(''); setCompReason(''); }
      reloadItems(); reloadOrder();
    } catch (e: unknown) {
      setCompMsg(e instanceof Error ? e.message : 'Failed to save comp');
    } finally {
      setSaving(false);
    }
  };

  // Direct-ship toggle: fulfillment routing only, no money — the manual
  // source sticks so imports never overwrite an operator's decision.
  const toggleDirectShip = async (it: ItemRow) => {
    if (!o) return;
    setSaving(true); setCompMsg('');
    try {
      const res = await doSetDirectShip({
        item_id: it.id, order_id: o.id, direct_ship: !it.direct_ship, actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setCompMsg('Direct-ship change refused.');
      reloadItems();
    } catch (e: unknown) {
      setCompMsg(e instanceof Error ? e.message : 'Failed to change direct-ship');
    } finally {
      setSaving(false);
    }
  };

  // Locally added items: the ordering app can be closed to item changes
  // while THIS app (what fulfillment runs from) still needs the truth.
  // Local rows survive every pull, bill on top of the upstream total, and
  // get adopted if the SKU later appears upstream.
  const addItem = async () => {
    if (!o) return;
    if (!addSku) { setAddMsg('Pick a product.'); return; }
    if (!/^\d+(?:\.\d{1,2})?$/.test(addQty.trim()) || !(Number(addQty) > 0)) { setAddMsg('Qty must be positive with at most 2 decimals.'); return; }
    setSaving(true); setAddMsg('');
    try {
      const res = await doAddLocalItem({
        order_id: o.id, group_buy_id: o.group_buy_id, sku: addSku, qty: addQty.trim(), actor: userName,
      }) as unknown[] | null;
      const wrote = Array.isArray(res) ? res.length > 0 : !!res;
      if (!wrote) setAddMsg('Refused — the product is already on the order (top-ups belong in the ordering app), or the order is already FULLY shipped (a new item on a closed order needs a shipment voided/refunded first).');
      else { setAddSku(''); setAddQty(''); }
      reloadItems(); reloadOrder();
    } catch (e: unknown) {
      setAddMsg(e instanceof Error ? e.message : 'Failed to add item');
    } finally {
      setSaving(false);
    }
  };

  const removeLocalItem = async (it: ItemRow) => {
    if (!o) return;
    if (!window.confirm(`Remove ${it.sku_code} × ${it.qty} (added in this app) from ${o.order_number}?`)) return;
    setSaving(true); setAddMsg('');
    try {
      const res = await doDeleteLocalItem({ order_id: o.id, item_id: it.id, actor: userName }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setAddMsg('Refused — only items added in this app can be removed, only while the order has not packed/shipped, and never the last active line (cancel the order instead).');
      reloadItems(); reloadOrder();
    } catch (e: unknown) {
      setAddMsg(e instanceof Error ? e.message : 'Failed to remove item');
    } finally {
      setSaving(false);
    }
  };

  // Credits (price reductions agreed with the customer — reduce due, book
  // in P&L like comps) and refunds (money returned from an overpay — reduce
  // effective received, capped server-side at the current overpay).
  type CreditRow = { id: number; amount_usd: string; reason: string; created_by: string | null; created_at: string };
  type RefundRow = { id: number; amount_usd: string; method: string; wallet_id: number | null; wallet_name: string | null; tx_ref: string | null; reason: string; created_by: string | null; created_at: string };
  const credits = rows<CreditRow>(rawCredits);
  const refunds = rows<RefundRow>(rawRefunds);
  const sheetWallets = rows<{ id: number; name: string; chain: string; active: boolean }>(rawSheetWallets);
  const reloadMoney = () => { reloadCredits(); reloadRefunds(); reloadOrder(); };

  const submitCredit = async () => {
    if (!o) return;
    if (!/^\d+(?:\.\d{1,2})?$/.test(creditAmt.trim()) || !(Number(creditAmt) > 0)) { setCrMsg('Credit must be a positive dollar amount, max 2 decimals.'); return; }
    if (!creditReason.trim()) { setCrMsg('A reason is required — credits are audited money.'); return; }
    setSaving(true); setCrMsg('');
    try {
      const res = await doAddCredit({ order_id: o.id, amount_usd: creditAmt.trim(), reason: creditReason.trim(), actor: userName }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setCrMsg('Credit refused — check the amount and reason.');
      else { setAddingCredit(false); setCreditAmt(''); setCreditReason(''); }
      reloadMoney();
    } catch (e: unknown) {
      setCrMsg(e instanceof Error ? e.message : 'Failed to add credit');
    } finally {
      setSaving(false);
    }
  };
  const removeCredit = async (c: CreditRow) => {
    if (!o || !window.confirm(`Remove the ${fmtUSD(c.amount_usd)} credit (“${c.reason}”)? The order will owe that much more again.`)) return;
    setSaving(true); setCrMsg('');
    try {
      await doDelCredit({ credit_id: c.id, order_id: o.id, actor: userName });
      reloadMoney();
    } catch (e: unknown) {
      setCrMsg(e instanceof Error ? e.message : 'Failed to remove credit');
    } finally {
      setSaving(false);
    }
  };
  const submitRefund = async () => {
    if (!o) return;
    if (!/^\d+(?:\.\d{1,2})?$/.test(refundAmt.trim()) || !(Number(refundAmt) > 0)) { setCrMsg('Refund must be a positive dollar amount, max 2 decimals.'); return; }
    if (!refundReason.trim()) { setCrMsg('A reason is required — refunds are audited money.'); return; }
    setSaving(true); setCrMsg('');
    try {
      const res = await doAddRefund({
        order_id: o.id, amount_usd: refundAmt.trim(), method: refundMethod,
        wallet_id: refundWallet, tx_ref: refundTxRef.trim(), reason: refundReason.trim(), actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setCrMsg('Refund refused — it cannot exceed the current overpayment.');
      else { setAddingRefund(false); setRefundAmt(''); setRefundTxRef(''); setRefundReason(''); setRefundWallet(''); }
      reloadMoney();
    } catch (e: unknown) {
      setCrMsg(e instanceof Error ? e.message : 'Failed to record refund');
    } finally {
      setSaving(false);
    }
  };
  const removeRefund = async (rf: RefundRow) => {
    if (!o || !window.confirm(`Remove the ${fmtUSD(rf.amount_usd)} refund record (“${rf.reason}”)? Only do this if it was recorded by mistake — it does not move any money.`)) return;
    setSaving(true); setCrMsg('');
    try {
      await doDelRefund({ refund_id: rf.id, order_id: o.id, actor: userName });
      reloadMoney();
    } catch (e: unknown) {
      setCrMsg(e instanceof Error ? e.message : 'Failed to remove refund');
    } finally {
      setSaving(false);
    }
  };

  // Item qty edits and removals (imported rows): overrides that survive
  // pulls; billing/demand/fulfillment follow the effective quantity. Local
  // rows keep their hard-delete path.
  const saveItemQty = async (it: ItemRow) => {
    if (!o) return;
    const v = qtyEditVal.trim();
    if (v !== '' && (!/^\d+(?:\.\d{1,2})?$/.test(v) || !(Number(v) > 0))) { setCompMsg('Qty must be positive with at most 2 decimals (blank = ordering app\'s qty).'); return; }
    setSaving(true); setCompMsg('');
    try {
      const res = await doSetItemQty({ item_id: it.id, order_id: o.id, qty: v, actor: userName }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setCompMsg('Qty edit refused — the new quantity may be below what shipments already packed/reserved for this line (void/refund that shipment first), or the line is removed.');
      else { setQtyEditId(null); setQtyEditVal(''); }
      reloadItems(); reloadOrder();
    } catch (e: unknown) {
      setCompMsg(e instanceof Error ? e.message : 'Failed to edit qty');
    } finally {
      setSaving(false);
    }
  };
  const toggleRemoved = async (it: ItemRow) => {
    if (!o) return;
    if (!it.removed_at && !window.confirm(`Remove ${it.sku_code} × ${Number(it.qty)} from ${o.order_number}?\n\nBilling, demand, and fulfillment drop it immediately; push the change to the ordering app when ready.`)) return;
    setSaving(true); setCompMsg('');
    try {
      const res = await doRemoveItem({ item_id: it.id, order_id: o.id, removed: !it.removed_at, actor: userName }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setCompMsg('Refused — a shipment already packed/reserved this line (void/refund it first), or this is the last active line (cancel the order instead of emptying it).');
      reloadItems(); reloadOrder();
    } catch (e: unknown) {
      setCompMsg(e instanceof Error ? e.message : 'Failed to change the line');
    } finally {
      setSaving(false);
    }
  };

  // Fee overrides: blank = follow the ordering app; a value wins over every
  // future pull. Recon bills the delta, so edits move what the customer owes.
  const eff = (override: string | null, base: string) => override != null ? Number(override) : Number(base);
  const openFeeEditor = () => {
    if (!o) return;
    setFeeAdmin(o.admin_fee_override_usd ?? '');
    setFeeShipping(o.shipping_fee_override_usd ?? '');
    setFeeInsurance(o.shipping_insurance_override_usd ?? '');
    setFeeTip(o.tip_override_usd ?? '');
    setFeeMsg(''); setEditingFees(true);
  };
  const saveFees = async () => {
    if (!o) return;
    for (const [label, v] of [['Admin fee', feeAdmin], ['Shipping fee', feeShipping], ['Insurance', feeInsurance], ['Tip', feeTip]] as const) {
      if (v.trim() !== '' && !/^\d+(?:\.\d{1,2})?$/.test(v.trim())) { setFeeMsg(`${label} must be a dollar amount with at most 2 decimals (blank = ordering app's value).`); return; }
    }
    setSaving(true); setFeeMsg('');
    try {
      const res = await doSetFees({
        order_id: o.id, admin_fee: feeAdmin.trim(), shipping_fee: feeShipping.trim(),
        insurance: feeInsurance.trim(), tip: feeTip.trim(), actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setFeeMsg('Refused — check the values (cancelled orders cannot be edited).');
      else setEditingFees(false);
      reloadOrder();
    } catch (e: unknown) {
      setFeeMsg(e instanceof Error ? e.message : 'Failed to save fees');
    } finally {
      setSaving(false);
    }
  };

  // Push local CHANGES — added items AND fee overrides — into the ordering
  // app's order record. The storefront being closed doesn't block this: it's
  // a direct entity write, same as the rail/tx-ref pushes. Read-merge-write
  // at click time; items already upstream and fees already matching are
  // skipped (retry-safe); the upstream subtotal/total move by the pushed
  // value so the next pull adopts the items and retires matching fee
  // overrides. Standing rules: local audit trail BEFORE the upstream
  // mutation, full-postcondition verification on error.
  const FEE_PUSH_MAP = [
    { field: 'admin_fee', label: 'admin fee', override: 'admin_fee_override_usd' },
    { field: 'shipping_fee', label: 'shipping fee', override: 'shipping_fee_override_usd' },
    { field: 'shipping_insurance_fee', label: 'insurance', override: 'shipping_insurance_override_usd' },
    { field: 'tip', label: 'tip', override: 'tip_override_usd' },
  ] as const;
  // the push builds from this sheet's React state, which can be stale when
  // the OTHER admin edits the same order: after every confirm, the local DB
  // state is re-read and compared on exactly the fields the push consumes —
  // any mismatch aborts, mirroring the upstream drift check on the local side
  const localItemsProj = (list: ItemRow[]) => JSON.stringify(list
    .map(i => [i.id, i.item_source, Number(i.qty), i.qty_override, i.removed_at ? 1 : 0, i.product_external_id, Number(i.unit_price_usd), i.direct_ship ? 1 : 0])
    .sort((a, b) => Number(a[0]) - Number(b[0])));
  const localOrderProj = (x: OrderRow) => JSON.stringify([
    x.admin_fee_override_usd, x.shipping_fee_override_usd, x.shipping_insurance_override_usd,
    x.tip_override_usd, x.total_usd, x.subtotal_usd, x.processor_fee_usd, x.external_id,
  ]);
  const localStateFresh = async () => {
    if (!o) return false;
    const freshItems = rows<ItemRow>(await fetchFreshItems({ order_id: o.id }) as unknown[]);
    const freshOrder = firstRow<OrderRow>(await fetchFreshOrder({ order_id: o.id }) as unknown[]);
    return !!freshOrder && localItemsProj(freshItems) === localItemsProj(items) && localOrderProj(freshOrder) === localOrderProj(o);
  };

  const pushChanges = async () => {
    if (!o || !o.external_id) return;
    const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
    const locals = items.filter(i => i.item_source === 'local');
    const unsynced = locals.filter(i => !i.product_external_id);
    if (unsynced.length > 0) {
      setAddMsg(`Cannot push: ${unsynced.map(i => i.sku_code).join(', ')} ${unsynced.length === 1 ? 'has' : 'have'} no ordering-app product id — pull products on the Products → Ordering app tab first.`);
      return;
    }
    setSaving(true); setAddMsg('');
    try {
      const cfg = { appId: settings.base44_app_id || B44_DEFAULT_APP_ID, token: settings.base44_token || '' };
      const b44 = await getB44Order(cfg, o.external_id);
      const upstreamIds = new Set((b44.items || []).map(x => String(x.product_id || '')));
      const upstreamQty = new Map((b44.items || []).map(x => [String(x.product_id || ''), Number(x.quantity ?? 0)]));
      const upstreamPrice = new Map((b44.items || []).map(x => [String(x.product_id || ''), Number(x.price ?? 0)]));
      const toAdd = locals.filter(i => !i.removed_at && !upstreamIds.has(String(i.product_external_id)));
      // qty edits on imported rows where upstream still disagrees; deltas
      // priced at the UPSTREAM item's own price so its totals stay internally
      // consistent
      const qtyEdits = items.filter(i => i.item_source === 'import' && !i.removed_at && i.qty_override != null
        && i.product_external_id && upstreamIds.has(String(i.product_external_id))
        && Math.round(Number(i.qty_override) * 100) !== Math.round((upstreamQty.get(String(i.product_external_id)) || 0) * 100));
      // locally-removed rows the ordering app still carries
      const removals = items.filter(i => i.removed_at != null
        && i.product_external_id && upstreamIds.has(String(i.product_external_id)));
      // fee overrides that differ from what upstream currently says
      const feeChanges = FEE_PUSH_MAP
        .map(f => ({ ...f, value: o[f.override] != null ? Number(o[f.override]) : null, current: Number(b44[f.field] ?? 0) }))
        .filter(f => f.value != null && Math.round(f.value * 100) !== Math.round(f.current * 100));
      if (toAdd.length === 0 && feeChanges.length === 0 && qtyEdits.length === 0 && removals.length === 0) {
        const hasAnyLocalState = locals.length > 0 || FEE_PUSH_MAP.some(f => o[f.override] != null)
          || items.some(i => i.qty_override != null || i.removed_at != null);
        if (!hasAnyLocalState) {
          setAddMsg('Nothing to push.');
          return;
        }
        // Items and fees match upstream — but a PARTIAL earlier push (or a
        // hand-edit of the fee fields upstream) can leave the TOTAL stale,
        // and a pull would then retire the overrides against a wrong total.
        // The expected figure is rebuilt from the upstream snapshot ITSELF
        // (items × upstream prices + upstream fees + the locally-known cash
        // processor gross-up), so it is internally consistent with the
        // upstream arrays by construction — local prices can never skew it.
        const expectedSubtotal = Math.round((b44.items || [])
          .reduce((s, x) => s + Number(x.quantity ?? 0) * Number(x.price ?? 0), 0) * 100) / 100;
        const upstreamFees = FEE_PUSH_MAP.reduce((s, f) => s + Number(b44[f.field] ?? 0), 0);
        // split-kit fees live inside the upstream total but NOT in its named
        // fee fields — without this term a correct split-order total would
        // read as drift and get "repaired" $5 low
        const expectedTotal = Math.round((expectedSubtotal + upstreamFees + Number(o.processor_fee_usd || 0) + Number(o.split_fee_usd || 0)) * 100) / 100;
        if (Math.round(Number(b44.total || 0) * 100) !== Math.round(expectedTotal * 100)) {
          if (!window.confirm(`The ordering app's items and fees match, but its TOTAL is ${fmtUSD(Number(b44.total || 0))} where ${fmtUSD(expectedTotal)} is expected (a partial earlier push, or an upstream edit).\n\nRepair the upstream total to ${fmtUSD(expectedTotal)}?`)) {
            setAddMsg('Upstream total left as-is — do NOT pull until it is fixed, or the fee edits will retire against the wrong total.');
            return;
          }
          // same discipline as the main push: the confirm is an unbounded
          // wait — re-read BOTH sides and abort on any drift in what this
          // PUT reads or overwrites before touching upstream
          if (!(await localStateFresh())) {
            setAddMsg('This order changed in this app while you were confirming — nothing was repaired. Review the refreshed order and retry.');
            reloadItems(); reloadOrder();
            return;
          }
          const freshR = await getB44Order(cfg, o.external_id);
          const repairDrifted = JSON.stringify(freshR.items || []) !== JSON.stringify(b44.items || [])
            || Number(freshR.subtotal || 0) !== Number(b44.subtotal || 0)
            || Number(freshR.total || 0) !== Number(b44.total || 0)
            || String(freshR.notes || '') !== String(b44.notes || '')
            || FEE_PUSH_MAP.some(f => Number(freshR[f.field] ?? 0) !== Number(b44[f.field] ?? 0));
          if (repairDrifted) {
            setAddMsg('The ordering app order changed while you were confirming — nothing was repaired. Re-check the order and retry.');
            return;
          }
          const repairLine = `${ts} repairing the ordering app's total: ${fmtUSD(Number(b44.total || 0))} → ${fmtUSD(expectedTotal)} (items/fees already matched).`;
          const repairRes = await doAppendNote({
            order_id: o.id, note: repairLine, actor: userName,
            detail: JSON.stringify({ total_repair: true, from: Number(b44.total || 0), to: expectedTotal }),
          }) as { admin_note: string }[] | { admin_note: string };
          setAdminNote(prev => (Array.isArray(repairRes) ? repairRes[0]?.admin_note : repairRes?.admin_note) ?? (prev ? `${prev}\n${repairLine}` : repairLine));
          const upRepairLine = `${ts} total corrected to $${expectedTotal.toFixed(2)} by SND GB Ops.`;
          let repErrMsg: string | null = null;
          try {
            await updateB44Order(cfg, o.external_id, {
              subtotal: expectedSubtotal,
              total: expectedTotal,
              notes: b44.notes ? `${b44.notes}\n${upRepairLine}` : upRepairLine,
            });
          } catch (repErr: unknown) {
            repErrMsg = repErr instanceof Error ? repErr.message : 'unknown error';
          }
          // verify on EVERY outcome, not just thrown errors
          let repLanded = false;
          try {
            const after = await getB44Order(cfg, o.external_id);
            repLanded = Math.round(Number(after.total || 0) * 100) === Math.round(expectedTotal * 100)
              && Math.round(Number(after.subtotal || 0) * 100) === Math.round(expectedSubtotal * 100)
              && String(after.notes || '').includes(upRepairLine);
          } catch { /* keep false */ }
          if (!repLanded) {
            const failLine = `${ts} total repair ${repErrMsg ? `error (${repErrMsg})` : 'did not verify after an apparently-successful write'} — check the ordering app and do NOT pull until its total is fixed.`;
            try {
              const failRes = await doAppendNote({ order_id: o.id, note: failLine, actor: userName, detail: JSON.stringify({ total_repair_error: true, landed: false, push_error: repErrMsg }) }) as { admin_note: string }[] | { admin_note: string };
              setAdminNote(prev => (Array.isArray(failRes) ? failRes[0]?.admin_note : failRes?.admin_note) ?? (prev ? `${prev}\n${failLine}` : failLine));
            } catch { /* surfaced below */ }
            setAddMsg('Total repair failed or did not verify — check the ordering app and do NOT pull until its total is fixed.');
            return;
          }
          setAddMsg('Upstream total repaired and verified. Run a pull — badges and edit markers clear automatically.');
          return;
        }
        setAddMsg('The ordering app already matches — run a pull and the badges/edit markers will clear automatically.');
        return;
      }
      const addValue = Math.round(toAdd.reduce((s, i) => s + effQty(i) * Number(i.unit_price_usd), 0) * 100) / 100;
      const editsDelta = Math.round(qtyEdits.reduce((s, i) => {
        const pid = String(i.product_external_id);
        return s + (Number(i.qty_override) - (upstreamQty.get(pid) || 0)) * (upstreamPrice.get(pid) || 0);
      }, 0) * 100) / 100;
      const removalsDelta = Math.round(removals.reduce((s, i) => {
        const pid = String(i.product_external_id);
        return s - (upstreamQty.get(pid) || 0) * (upstreamPrice.get(pid) || 0);
      }, 0) * 100) / 100;
      // removing a split (half-kit) line also releases its charged split
      // fee: the fee lives in the upstream TOTAL (not the subtotal), so it
      // gets its own delta term. Whole<->half transitions are refused
      // locally, so removals are the only path that moves a fee.
      const splitFeeDelta = Math.round(removals.reduce((s, i) => s - Number(i.split_fee_usd || 0), 0) * 100) / 100;
      const feeDelta = Math.round(feeChanges.reduce((s, f) => s + (f.value! - f.current), 0) * 100) / 100;
      const itemsSummary = [
        toAdd.map(i => `add ${i.sku_code} × ${effQty(i)}`).join(', '),
        qtyEdits.map(i => `${i.sku_code} qty ${upstreamQty.get(String(i.product_external_id))} → ${Number(i.qty_override)}`).join(', '),
        removals.map(i => `remove ${i.sku_code} × ${upstreamQty.get(String(i.product_external_id))}${Number(i.split_fee_usd || 0) > 0 ? ` (releases ${fmtUSD(i.split_fee_usd)} split fee)` : ''}`).join(', '),
      ].filter(Boolean).join('; ');
      const feesSummary = feeChanges.map(f => `${f.label} ${fmtUSD(f.current)} → ${fmtUSD(f.value!)}`).join(', ');
      const summary = [itemsSummary, feesSummary].filter(Boolean).join('; ');
      const productDelta = Math.round((addValue + editsDelta + removalsDelta) * 100) / 100;
      const totalDelta = Math.round((productDelta + feeDelta + splitFeeDelta) * 100) / 100;
      // an order can't exist upstream with zero items — removing everything
      // is a cancellation, which has its own flow
      const removedIds = new Set(removals.map(i => String(i.product_external_id)));
      if ((b44.items || []).every(x => removedIds.has(String(x.product_id || ''))) && toAdd.length === 0) {
        setAddMsg('This would remove every item from the upstream order — cancel the order instead of pushing an empty item list.');
        return;
      }
      if (!window.confirm(`Push to the ordering app order ${o.order_number}?\n\n${summary}\n\nUpstream total ${totalDelta >= 0 ? 'increases' : 'decreases'} by ${fmtUSD(Math.abs(totalDelta))}.`)) return;

      // The confirm dialog is an unbounded wait between read and write — a
      // PUT built on a stale snapshot would silently erase any upstream
      // change made meanwhile. Re-read BOTH sides after the confirm: the
      // local DB (the other admin may have changed the very edits this push
      // carries) and the upstream order; abort on any drift.
      if (!(await localStateFresh())) {
        setAddMsg('This order changed in this app while you were confirming — nothing was pushed. Review the refreshed order and retry.');
        reloadItems(); reloadOrder();
        return;
      }
      const fresh = await getB44Order(cfg, o.external_id);
      const drifted = JSON.stringify(fresh.items || []) !== JSON.stringify(b44.items || [])
        || Number(fresh.subtotal || 0) !== Number(b44.subtotal || 0)
        || Number(fresh.total || 0) !== Number(b44.total || 0)
        || String(fresh.notes || '') !== String(b44.notes || '')
        || FEE_PUSH_MAP.some(f => Number(fresh[f.field] ?? 0) !== Number(b44[f.field] ?? 0));
      if (drifted) {
        setAddMsg('The ordering app order changed while you were confirming — nothing was pushed. Re-check the order and retry.');
        return;
      }

      const pushingLine = `${ts} pushing changes to the ordering app: ${summary} (total ${totalDelta >= 0 ? '+' : '−'}${fmtUSD(Math.abs(totalDelta))}).`;
      const pushingRes = await doAppendNote({
        order_id: o.id, note: pushingLine, actor: userName,
        detail: JSON.stringify({ changes_push: true, skus: toAdd.map(i => i.sku_code), fees: feeChanges.map(f => f.field), total_delta_usd: totalDelta }),
      }) as { admin_note: string }[] | { admin_note: string };
      setAdminNote(prev => (Array.isArray(pushingRes) ? pushingRes[0]?.admin_note : pushingRes?.admin_note) ?? (prev ? `${prev}\n${pushingLine}` : pushingLine));

      const editedQtyByPid = new Map(qtyEdits.map(i => [String(i.product_external_id), Number(i.qty_override)]));
      const newItems = [
        ...(b44.items || [])
          .filter(x => !removedIds.has(String(x.product_id || '')))
          .map(x => editedQtyByPid.has(String(x.product_id || ''))
            ? { ...x, quantity: editedQtyByPid.get(String(x.product_id || '')) }
            : x),
        ...toAdd.map(i => ({
          product_id: i.product_external_id,
          product_name: i.product_name || i.sku_code,
          price: Number(i.unit_price_usd),
          quantity: effQty(i),
          shipped_date: null,
          vendor_paid: false,
          coa_link: null,
          wants_direct_ship: i.direct_ship || null,
          direct_ship_threshold: null,
        })),
      ];
      const upLine = `${ts} order updated by SND GB Ops (ordering closed): ${summary} (total ${totalDelta >= 0 ? '+' : '−'}$${Math.abs(totalDelta).toFixed(2)}).`;
      const newSubtotal = Math.round((Number(b44.subtotal || 0) + productDelta) * 100) / 100;
      const newTotal = Math.round((Number(b44.total || 0) + totalDelta) * 100) / 100;
      const feeFields = Object.fromEntries(feeChanges.map(f => [f.field, f.value]));
      let pushErrMsg: string | null = null;
      try {
        await updateB44Order(cfg, o.external_id, {
          items: newItems,
          ...feeFields,
          subtotal: newSubtotal,
          total: newTotal,
          notes: b44.notes ? `${b44.notes}\n${upLine}` : upLine,
        });
      } catch (pushErr: unknown) {
        pushErrMsg = pushErr instanceof Error ? pushErr.message : 'unknown error';
      }
      // verify the FULL intended postcondition on EVERY outcome — a 2xx that
      // partially applied or normalized fields away must never read as
      // success and send the operator to a pull that retires markers wrongly
      let landed = false;
      let outcome = 'outcome UNKNOWN — check the ordering app before retrying';
      try {
        const after = await getB44Order(cfg, o.external_id);
        const afterIds = new Set((after.items || []).map(x => String(x.product_id || '')));
        const afterQty = new Map((after.items || []).map(x => [String(x.product_id || ''), Number(x.quantity ?? 0)]));
        const afterPrice = new Map((after.items || []).map(x => [String(x.product_id || ''), Number(x.price ?? 0)]));
        // added rows verify qty AND price — an upstream normalization that
        // kept the row but changed either would adopt wrong demand/money
        const itemsOk = toAdd.every(i => afterIds.has(String(i.product_external_id))
            && Math.round((afterQty.get(String(i.product_external_id)) || 0) * 100) === Math.round(effQty(i) * 100)
            && Math.round((afterPrice.get(String(i.product_external_id)) || 0) * 100) === Math.round(Number(i.unit_price_usd) * 100))
          && qtyEdits.every(i => Math.round((afterQty.get(String(i.product_external_id)) || 0) * 100) === Math.round(Number(i.qty_override) * 100))
          && removals.every(i => !afterIds.has(String(i.product_external_id)));
        const feesOk = feeChanges.every(f => Math.round(Number(after[f.field] ?? 0) * 100) === Math.round(f.value! * 100));
        const noteOk = String(after.notes || '').includes(upLine);
        // the totals ARE the money invariant: changes landing without the
        // adjusted subtotal/total would converge on the next pull against
        // a stale total and misbill — never call that landed
        const totalsOk = Math.round(Number(after.subtotal || 0) * 100) === Math.round(newSubtotal * 100)
          && Math.round(Number(after.total || 0) * 100) === Math.round(newTotal * 100);
        landed = itemsOk && feesOk && noteOk && totalsOk;
        outcome = landed ? 'verified upstream (items + fees + totals + note)'
          : (itemsOk && feesOk && !totalsOk) ? `PARTIAL: items/fees are upstream but subtotal/total do NOT match the intended ${fmtUSD(newSubtotal)}/${fmtUSD(newTotal)} — fix the totals upstream manually BEFORE the next pull, or it will import a wrong total`
          : (itemsOk && feesOk) ? 'PARTIAL: items, fees, and totals are upstream but the note is missing — add the note upstream manually'
          : 'upstream is unchanged or partially changed — check the ordering app, then retry the push';
      } catch { /* keep UNKNOWN */ }
      if (!landed) {
        const failLine = `${ts} changes push ${pushErrMsg ? `error (${pushErrMsg})` : 'verification failed after an apparently-successful write'} — ${outcome}.`;
        let noted = false;
        try {
          const failRes = await doAppendNote({ order_id: o.id, note: failLine, actor: userName, detail: JSON.stringify({ changes_push_error: true, landed, push_error: pushErrMsg }) }) as { admin_note: string }[] | { admin_note: string };
          setAdminNote(prev => (Array.isArray(failRes) ? failRes[0]?.admin_note : failRes?.admin_note) ?? (prev ? `${prev}\n${failLine}` : failLine));
          noted = true;
        } catch { /* surfaced below */ }
        setAddMsg(`Ordering app push ${pushErrMsg ? 'failed' : 'did not verify'} (${outcome}).${noted ? '' : ' The audit note ALSO failed to write — record this manually.'}`);
        return;
      }
      setAddMsg('Pushed and verified. Run a pull — added items adopt, qty and fee edits retire, and removed lines clear automatically.');
    } catch (e: unknown) {
      setAddMsg(e instanceof Error ? e.message : 'Failed to push changes');
    } finally {
      setSaving(false);
    }
  };

  // Per-LINE vendor-shipped state: two direct SKUs (possibly from different
  // vendors) complete separately — the fulfillment tab's bulk button covers
  // the everything-shipped case.
  const markLineDirectFulfilled = async (it: ItemRow, fulfilled: boolean) => {
    if (!o) return;
    setSaving(true); setCompMsg('');
    try {
      const res = await doMarkDirectFulfilled({
        order_id: o.id, item_id: String(it.id), expected_ids: '', fulfilled, actor: userName,
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) setCompMsg('Nothing to change on that line.');
      reloadItems();
    } catch (e: unknown) {
      setCompMsg(e instanceof Error ? e.message : 'Failed to update vendor-shipped state');
    } finally {
      setSaving(false);
    }
  };

  const recordCashPayment = async () => {
    if (!o) return;
    const amt = Number(cashAmt);
    if (!(amt > 0)) { setCashMsg('Amount must be positive.'); return; }
    setSaving(true); setCashMsg('');
    try {
      // Same atomic action as the recon manual tab: resolves by campaign +
      // order number, refuses cancelled/refunded, audited.
      const res = await doCashPay({
        group_buy_id: o.group_buy_id, order_number: o.order_number, method: cashMethod,
        tx_hash: '', receipt_ref: cashRef, amount_usd: amt, notes: '', actor: userName,
      }) as { inserted: string }[] | { inserted: string };
      const inserted = Number(Array.isArray(res) ? res[0]?.inserted : res?.inserted);
      if (!inserted) { setCashMsg('Could not record — the order may be cancelled/refunded.'); }
      else { setCashAmt(''); setCashRef(''); setCashMsg('Recorded — counts as received immediately.'); }
      reloadPayments(); reloadOrder();
    } catch (e: unknown) {
      setCashMsg(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      setSaving(false);
    }
  };

  const rejectPayment = async (p: PaymentRow) => {
    if (!rejectReason.trim()) { setPayMsg('A reason is required — rejections are audited.'); return; }
    setSaving(true); setPayMsg('');
    try {
      // Guarded by the status this row showed when Reject was clicked — if
      // the verifier changed it mid-flight, nothing is written and the fresh
      // state is reloaded for a deliberate second look.
      const res = await doPayStatus({
        payment_id: p.id, status: 'rejected', amount_usd: 0,
        notes: rejectReason.trim(), actor: userName, expected_status: p.status,
      }) as unknown[] | null;
      const wrote = Array.isArray(res) ? res.length > 0 : !!res;
      if (!wrote) {
        setPayMsg('This payment changed while you were looking at it (likely just verified) — review the fresh state before rejecting.');
      } else {
        setRejectingId(null); setRejectReason('');
      }
      reloadPayments(); reloadOrder();
    } catch (e: unknown) {
      setPayMsg(e instanceof Error ? e.message : 'Failed to reject payment');
    } finally {
      setSaving(false);
    }
  };

  const addHash = async () => {
    if (!o) return;
    const h = normalizeTxHash(newHashMethod, newHash);
    if (!h) { setPayMsg(`That doesn't look like a valid ${newHashMethod.toUpperCase()} transaction hash (bare hash or explorer URL).`); return; }
    setSaving(true); setPayMsg('');
    try {
      const res = await doAddHash({ order_id: o.id, method: newHashMethod, tx_hash: h, actor: userName }) as { inserted: string }[] | { inserted: string };
      const inserted = Number(Array.isArray(res) ? res[0]?.inserted : res?.inserted);
      if (!inserted) { setPayMsg('That hash is already recorded on a non-rejected payment — or was rejected on this very order.'); }
      else { setPayMsg('Added as pending — click Verify next to it to confirm on-chain.'); setNewHash(''); }
      reloadPayments();
    } catch (e: unknown) {
      setPayMsg(e instanceof Error ? e.message : 'Failed to add hash');
    } finally {
      setSaving(false);
    }
  };

  const pushTxRefs = async () => {
    if (!o?.external_id) return;
    setPushing(true); setPushMsg('');
    try {
      const cfg = { appId: settings.base44_app_id || B44_DEFAULT_APP_ID, token: settings.base44_token || '' };
      // Read the local ref state from the DB at push time — never from this
      // render's payments array, which can lag a just-completed reject/add.
      const res = await doGetTxRefs({ order_id: o.id }) as { refs: string; rejected_refs: string }[] | { refs: string; rejected_refs: string };
      const row = Array.isArray(res) ? res[0] : res;
      const local = (row?.refs ?? '').split('|').map(s => s.trim()).filter(Boolean);
      // Canonical comparison (EVM hashes lowercase) so a checksum-cased copy
      // upstream still matches the locally stored form; SOL stays verbatim.
      const rejected = new Set((row?.rejected_refs ?? '').split('|').map(s => canonicalTxRef(s)).filter(Boolean));
      // Read-merge-write, not last-writer-wins: keep every upstream entry we
      // didn't explicitly reject (a ref added in the ordering app since the
      // last pull must survive this push), then append our refs not present.
      const remote = await getB44Order(cfg, o.external_id);
      const upstream = String(remote.transaction_hashtags || '').split('|').map(s => s.trim()).filter(Boolean);
      const removed = upstream.filter(u => rejected.has(canonicalTxRef(u)));
      const kept = upstream.filter(u => !rejected.has(canonicalTxRef(u)));
      const keptSet = new Set(kept.map(canonicalTxRef));
      const added = local.filter(h => !keptSet.has(canonicalTxRef(h)));
      if (removed.length === 0 && added.length === 0) {
        setPushMsg('Upstream already matches — nothing pushed, no note added.');
        return;
      }
      const merged = [...kept, ...added];
      // Every upstream mutation leaves a local trail. The note is written
      // BEFORE the PUT: a note for a push that then fails is visible and gets
      // a follow-up failure line, whereas a push without a note would be an
      // invisible upstream mutation — the exact thing the trail exists for.
      const ts = () => `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
      const parts = [
        removed.length ? `removed ${removed.map(h => shortHash(h)).join(', ')}` : '',
        added.length ? `added ${added.map(h => shortHash(h)).join(', ')}` : '',
        `kept ${kept.length} upstream ref(s)`,
      ].filter(Boolean).join('; ');
      const note = `${ts()} ${userName} pushed tx refs to ordering app: ${parts}.`;
      const syncNote = (line: string, dbNote: string | undefined) => {
        // Pristine editor follows the DB; a dirty draft gets the trail line
        // appended so a later manual save can't erase it.
        setAdminNote(prev => {
          const pristine = prev === (o.admin_note || '');
          if (pristine && typeof dbNote === 'string') return dbNote;
          if (prev.includes(line)) return prev; // retries must not duplicate trail lines
          return prev ? `${prev}\n${line}` : line;
        });
      };
      const noteRes = await doAppendNote({
        order_id: o.id, note, actor: userName,
        detail: JSON.stringify({ removed, added, kept_count: kept.length, pushed: merged }),
      }) as { admin_note: string }[] | { admin_note: string };
      const writtenNote = Array.isArray(noteRes) ? noteRes[0]?.admin_note : noteRes?.admin_note;
      if (typeof writtenNote !== 'string') {
        throw new Error('Could not write the admin-note trail entry — upstream NOT pushed.');
      }
      syncNote(note, writtenNote);
      // Mirror the correction note into the ordering app's own notes field,
      // in the SAME PUT as the ref list (one atomic upstream write). Append
      // to whatever is upstream already; skip if this exact line is present.
      const upstreamNotes = String(remote.notes || '');
      const mirroredNotes = upstreamNotes.includes(note)
        ? upstreamNotes
        : (upstreamNotes ? `${upstreamNotes}\n${note}` : note);
      try {
        await updateB44Order(cfg, o.external_id, { transaction_hashtags: merged.join(' | '), notes: mirroredNotes });
      } catch (pushErr: unknown) {
        // A thrown PUT is not proof the write didn't land (timeouts can follow
        // acceptance). Verify by re-reading upstream before asserting anything.
        let outcome = 'outcome UNKNOWN — could not re-check upstream; verify manually before retrying';
        try {
          const check = await getB44Order(cfg, o.external_id);
          const nowSet = new Set(String(check.transaction_hashtags || '').split('|').map(s => canonicalTxRef(s.trim())).filter(Boolean));
          const wantSet = new Set(merged.map(h => canonicalTxRef(h)));
          const same = nowSet.size === wantSet.size && [...wantSet].every(h => nowSet.has(h));
          outcome = same
            ? 'verified: the push actually LANDED despite the error — the line above IS in effect'
            : 'verified: upstream unchanged — the line above did not take effect';
        } catch { /* keep UNKNOWN */ }
        const failLine = `${ts()} push error (${pushErr instanceof Error ? pushErr.message : 'unknown error'}) — ${outcome}.`;
        try {
          const failRes = await doAppendNote({ order_id: o.id, note: failLine, actor: userName, detail: JSON.stringify({ push_error: true, outcome }) }) as { admin_note: string }[] | { admin_note: string };
          syncNote(failLine, Array.isArray(failRes) ? failRes[0]?.admin_note : failRes?.admin_note);
        } catch { /* the visible error below still tells the operator */ }
        throw pushErr;
      }
      reloadOrder();
      setPushMsg(`Pushed ${merged.length} tx ref(s) (${removed.length} removed, ${added.length} added) — noted locally and in the ordering app's notes.`);
    } catch (e: unknown) {
      setPushMsg(e instanceof Error ? e.message : 'Push failed');
    } finally {
      setPushing(false);
    }
  };

  const save = async () => {
    if (!o) return;
    setSaving(true); setError('');
    try {
      await doUpdate({ order_id: o.id, status, hold_shipping: hold, admin_note: adminNote, actor: userName });
      reloadOrder();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const saveOverride = async () => {
    if (!o) return;
    const amt = Number(overrideAmt);
    if (!(amt >= 0) || !overrideReason.trim()) {
      setError('Override needs an amount and a reason — overrides are audited.');
      return;
    }
    setSaving(true); setError('');
    try {
      await doOverride({ order_id: o.id, amount_usd: amt, reason: overrideReason.trim(), created_by: userName });
      setOverrideAmt(''); setOverrideReason('');
      reloadOrder();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save override');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        {o && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                {o.order_number} <StatusPill value={o.recon_status || 'awaiting'} />
              </SheetTitle>
            </SheetHeader>
            <div className="space-y-5 mt-4 text-sm">
              <div>
                <div className="font-medium">{o.customer_name}</div>
                <div className="text-muted-foreground">{o.contact_email} {o.contact_phone ? `· ${o.contact_phone}` : ''} {o.discord_username ? `· ${o.discord_username}` : ''}</div>
                <div className="text-muted-foreground mt-1">
                  {o.address_line1}{o.address_line2 ? `, ${o.address_line2}` : ''}, {o.city}, {o.state_code} {o.postal_code}
                </div>
                <div className="text-xs text-muted-foreground mt-1">Placed {fmtDateTime(o.placed_at)} · rail: {o.payment_rail}</div>
              </div>

              {o.customer_note && (
                <div className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">
                  <span className="text-xs font-semibold uppercase">Customer note</span>
                  <p className="mt-0.5 whitespace-pre-wrap">{o.customer_note}</p>
                </div>
              )}

              <div>
                <h3 className="font-semibold mb-1">Items</h3>
                {items.map(it => (
                  <div key={it.id} className="py-0.5">
                    <div className="flex justify-between items-center gap-2">
                      <span className="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">
                        <span className={`truncate ${it.removed_at ? 'line-through text-muted-foreground' : ''}`}>
                          {it.sku_code} × {effQty(it) || Number(it.qty)}
                          {it.qty_override != null && !it.removed_at && (
                            <span className="text-amber-700" title={`Ordering app: ${Number(it.qty)}`}> (edited)</span>
                          )}
                        </span>
                        {it.removed_at && (
                          <span className="rounded bg-red-100 text-red-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                            title="Removed in this app — the ordering app still carries it until you push">
                            removed
                          </span>
                        )}
                        {Number(it.comp_qty) > 0 && (
                          <span
                            className="rounded bg-green-100 text-green-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                            title={it.comp_reason || ''}
                          >
                            comp {Number(it.comp_qty)} · −{fmtUSD(it.comp_value_usd)}
                          </span>
                        )}
                        {it.item_source === 'local' && (
                          <span
                            className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                            title="Added in this app — not in the ordering app yet; survives pulls and bills on top of the order total"
                          >
                            added here
                          </span>
                        )}
                        {effQty(it) % 1 !== 0 && (
                          <span
                            className="rounded bg-sky-100 text-sky-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                            title="Half kit — billed at half the kit price plus the split kit fee (already in the order total)"
                          >
                            split kit
                          </span>
                        )}
                        {it.direct_ship && (
                          <span
                            className={`rounded text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap ${it.direct_fulfilled_at ? 'bg-green-100 text-green-900' : 'bg-violet-100 text-violet-900'}`}
                            title={`${it.direct_ship_source === 'manual' ? 'Set manually here' : 'From the ordering app'}${it.direct_fulfilled_at ? ` · shipped ${fmtDateTime(it.direct_fulfilled_at)}` : ' · not shipped yet'}${it.direct_tracking_number ? ` · ${(it.direct_carrier || '').toUpperCase()} ${it.direct_tracking_number} (label bought via Receiving → Transfers)` : ''}`}
                          >
                            {it.direct_fulfilled_at ? 'direct ✓' : 'direct ship'}
                          </span>
                        )}
                        {it.direct_tracking_number && (
                          <span className="text-[10px] font-mono text-muted-foreground whitespace-nowrap" title="Tracking from the transfer label bought for this line">
                            {(it.direct_carrier || '').toUpperCase()} {it.direct_tracking_number}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-1.5 shrink-0">
                        <span className={it.removed_at ? 'line-through text-muted-foreground' : ''}>{fmtUSD(effQty(it) * Number(it.unit_price_usd))}</span>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button size="sm" variant="outline" className="h-6 w-6 p-0 text-muted-foreground" disabled={saving} title="Line actions">⋯</Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="text-xs">
                            {!it.removed_at && (
                              <DropdownMenuItem onClick={() => { setCompingId(it.id); setCompQty(String(Number(it.comp_qty) || '')); setCompReason(it.comp_reason || ''); setCompMsg(''); }}>
                                {Number(it.comp_qty) > 0 ? 'Edit comp' : 'Comp'}
                              </DropdownMenuItem>
                            )}
                            {!it.removed_at && (
                              <DropdownMenuItem onClick={() => { setQtyEditId(it.id); setQtyEditVal(it.qty_override ?? ''); setCompMsg(''); }}>
                                Edit qty
                              </DropdownMenuItem>
                            )}
                            {!it.removed_at && (
                              <DropdownMenuItem onClick={() => toggleDirectShip(it)} title="Who ships this line to the customer">
                                {it.direct_ship ? 'Ships from us' : 'Direct ship from vendor'}
                              </DropdownMenuItem>
                            )}
                            {it.direct_ship && !it.removed_at && (
                              <DropdownMenuItem onClick={() => markLineDirectFulfilled(it, !it.direct_fulfilled_at)} title="Track whether the vendor has shipped this line">
                                {it.direct_fulfilled_at ? 'Undo vendor shipped' : 'Vendor shipped'}
                              </DropdownMenuItem>
                            )}
                            {it.item_source === 'local' ? (
                              <DropdownMenuItem className="text-red-600" onClick={() => removeLocalItem(it)}>
                                Remove
                              </DropdownMenuItem>
                            ) : it.removed_at ? (
                              <DropdownMenuItem onClick={() => toggleRemoved(it)}>
                                Restore
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem className="text-red-600" onClick={() => toggleRemoved(it)}>
                                Remove
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </span>
                    </div>
                    {qtyEditId === it.id && (
                      <div className="flex flex-wrap gap-2 mt-1 items-center">
                        <Input placeholder={`Qty (ordering app: ${Number(it.qty)})`} value={qtyEditVal} onChange={e => setQtyEditVal(e.target.value)} className="h-7 w-40 text-xs" />
                        <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => saveItemQty(it)}>Save</Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setQtyEditId(null); setCompMsg(''); }}>Cancel</Button>
                        <span className="text-[11px] text-muted-foreground">Blank = follow the ordering app. Billing and demand shift by the difference.</span>
                      </div>
                    )}
                    {compingId === it.id && (
                      <div className="flex flex-wrap gap-2 mt-1 items-center">
                        <Input placeholder={`Free units (max ${effQty(it)})`} value={compQty} onChange={e => setCompQty(e.target.value)} className="h-7 w-32 text-xs" />
                        <Input placeholder="Why is this free? (audited)" value={compReason} onChange={e => setCompReason(e.target.value)} className="h-7 flex-1 min-w-40 text-xs" />
                        <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => saveComp(it, compQty || '0', compReason)}>Save</Button>
                        {Number(it.comp_qty) > 0 && (
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600" disabled={saving} onClick={() => saveComp(it, '0', '')}>Remove comp</Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setCompingId(null); setCompMsg(''); }}>Cancel</Button>
                      </div>
                    )}
                  </div>
                ))}
                {compMsg && <p className="text-xs text-red-600 mt-1">{compMsg}</p>}
                <div className="flex flex-wrap gap-1.5 mt-2 items-center">
                  <Select value={addSku} onValueChange={v => { setAddSku(v); setAddMsg(''); }}>
                    <SelectTrigger className="h-7 flex-1 min-w-36 text-xs"><SelectValue placeholder="Add item…" /></SelectTrigger>
                    <SelectContent>
                      {campaignProducts.map(p => (
                        <SelectItem key={p.sku_code} value={p.sku_code}>{p.sku_code} @ {fmtUSD(p.gb_price_usd)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input placeholder="Qty" value={addQty} onChange={e => setAddQty(e.target.value)} className="h-7 w-16 text-xs" />
                  <Button size="sm" className="h-7 text-xs" disabled={saving || !addSku} onClick={addItem}>Add</Button>
                  {(localItemsUsd > 0 || feeDeltaUsd !== 0 || itemDeltaUsd !== 0) && o.external_id && (
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={saving} onClick={pushChanges}
                      title="Write added items and fee edits into the ordering app's order (works even while ordering is closed) and adjust its total to match">
                      Push changes to ordering app
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Added items bill on top of the order total and survive pulls; they're marked until the ordering app learns about them.
                </p>
                {addMsg && <p className="text-xs text-red-600 mt-1">{addMsg}</p>}
                <Separator className="my-2" />
                <div className="space-y-0.5 text-muted-foreground">
                  <div className="flex justify-between"><span>Subtotal</span><span>{fmtUSD(o.subtotal_usd)}</span></div>
                  {(eff(o.tip_override_usd, o.tip_usd) > 0 || o.tip_override_usd != null) && (
                    <div className="flex justify-between"><span>Tip{o.tip_override_usd != null && <span className="text-amber-700" title={`Ordering app: ${fmtUSD(o.tip_usd)}`}> (edited)</span>}</span><span>{fmtUSD(eff(o.tip_override_usd, o.tip_usd))}</span></div>
                  )}
                  <div className="flex justify-between"><span>Admin fee{o.admin_fee_override_usd != null && <span className="text-amber-700" title={`Ordering app: ${fmtUSD(o.admin_fee_usd)}`}> (edited)</span>}</span><span>{fmtUSD(eff(o.admin_fee_override_usd, o.admin_fee_usd))}</span></div>
                  <div className="flex justify-between"><span>Shipping fee{o.shipping_fee_override_usd != null && <span className="text-amber-700" title={`Ordering app: ${fmtUSD(o.shipping_fee_usd)}`}> (edited)</span>}</span><span>{fmtUSD(eff(o.shipping_fee_override_usd, o.shipping_fee_usd))}</span></div>
                  {(eff(o.shipping_insurance_override_usd, o.shipping_insurance_usd) > 0 || o.shipping_insurance_override_usd != null) && (
                    <div className="flex justify-between"><span>Shipping insurance{o.shipping_insurance_override_usd != null && <span className="text-amber-700" title={`Ordering app: ${fmtUSD(o.shipping_insurance_usd)}`}> (edited)</span>}</span><span>{fmtUSD(eff(o.shipping_insurance_override_usd, o.shipping_insurance_usd))}</span></div>
                  )}
                  {Number(o.split_fee_usd) > 0 && (
                    <div className="flex justify-between"><span title="Charged by the ordering app for splitting a kit — already inside the total">Split kit fee</span><span>{fmtUSD(o.split_fee_usd)}</span></div>
                  )}
                  {Number(o.processor_fee_usd) > 0 && <div className="flex justify-between"><span>Processor fee</span><span>{fmtUSD(o.processor_fee_usd)}</span></div>}
                  <div className="flex justify-between font-semibold text-foreground"><span>Total</span><span>{fmtUSD(o.total_usd)}</span></div>
                  {(localItemsUsd > 0 || feeDeltaUsd !== 0 || itemDeltaUsd !== 0) && (
                    <>
                      {localItemsUsd > 0 && <div className="flex justify-between text-amber-700"><span>Added in this app</span><span>+{fmtUSD(localItemsUsd)}</span></div>}
                      {itemDeltaUsd !== 0 && <div className="flex justify-between text-amber-700"><span>Item edits</span><span>{itemDeltaUsd > 0 ? '+' : '−'}{fmtUSD(Math.abs(itemDeltaUsd))}</span></div>}
                      {feeDeltaUsd !== 0 && <div className="flex justify-between text-amber-700"><span>Fee edits</span><span>{feeDeltaUsd > 0 ? '+' : '−'}{fmtUSD(Math.abs(feeDeltaUsd))}</span></div>}
                      <div className="flex justify-between font-semibold text-foreground"><span>Expected total</span><span>{fmtUSD(Number(o.total_usd) + localItemsUsd + feeDeltaUsd + itemDeltaUsd)}</span></div>
                    </>
                  )}
                  <div className="pt-1">
                    {!editingFees ? (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={openFeeEditor}>Edit fees</Button>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex flex-wrap gap-1.5">
                          <Input placeholder={`Admin (${Number(o.admin_fee_usd)})`} value={feeAdmin} onChange={e => setFeeAdmin(e.target.value)} className="h-7 w-24 text-xs" />
                          <Input placeholder={`Shipping (${Number(o.shipping_fee_usd)})`} value={feeShipping} onChange={e => setFeeShipping(e.target.value)} className="h-7 w-24 text-xs" />
                          <Input placeholder={`Insurance (${Number(o.shipping_insurance_usd)})`} value={feeInsurance} onChange={e => setFeeInsurance(e.target.value)} className="h-7 w-24 text-xs" />
                          <Input placeholder={`Tip (${Number(o.tip_usd)})`} value={feeTip} onChange={e => setFeeTip(e.target.value)} className="h-7 w-24 text-xs" />
                          <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={saveFees}>Save</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingFees(false)}>Cancel</Button>
                        </div>
                        <p className="text-[11px] text-muted-foreground">Blank = follow the ordering app. A value wins over every pull; billing shifts by the difference.</p>
                        {feeMsg && <p className="text-xs text-red-600">{feeMsg}</p>}
                      </div>
                    )}
                  </div>
                  {Number(o.comp_usd) > 0 && (
                    <div className="flex justify-between text-green-700"><span>Comped items</span><span>−{fmtUSD(o.comp_usd)}</span></div>
                  )}
                  {credits.map(c => (
                    <div key={c.id} className="flex justify-between text-green-700 items-center gap-2">
                      <span className="truncate" title={c.reason}>Credit — {c.reason}</span>
                      <span className="flex items-center gap-1 shrink-0">
                        −{fmtUSD(c.amount_usd)}
                        <Button size="sm" variant="ghost" className="h-4 px-1 text-[10px] text-red-600" disabled={saving} onClick={() => removeCredit(c)}>✕</Button>
                      </span>
                    </div>
                  ))}
                  {Number(o.writeoff_usd) > 0 && (
                    <div className="flex justify-between text-green-700"><span>Write-off</span><span>−{fmtUSD(o.writeoff_usd)}</span></div>
                  )}
                  {(Number(o.comp_usd) > 0 || Number(o.writeoff_usd) > 0 || credits.length > 0) && (
                    <div className="flex justify-between font-semibold text-foreground"><span>Due</span><span>{fmtUSD(o.due_usd)}</span></div>
                  )}
                  <div className="flex justify-between"><span>Received (effective)</span><span>{fmtUSD(o.effective_received_usd)}</span></div>
                  {refunds.map(rf => (
                    <div key={rf.id} className="flex justify-between text-amber-700 items-center gap-2">
                      <span className="truncate" title={`${rf.reason}${rf.tx_ref ? ` · ${rf.tx_ref}` : ''}`}>
                        Refunded ({rf.method}{rf.wallet_name ? ` · ${rf.wallet_name}` : ''}) — {rf.reason}
                      </span>
                      <span className="flex items-center gap-1 shrink-0">
                        −{fmtUSD(rf.amount_usd)}
                        <Button size="sm" variant="ghost" className="h-4 px-1 text-[10px] text-red-600" disabled={saving} onClick={() => removeRefund(rf)}>✕</Button>
                      </span>
                    </div>
                  ))}
                  <div className="flex flex-wrap gap-2 mt-1">
                    {!addingCredit && (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => { setAddingCredit(true); setAddingRefund(false); setCrMsg(''); }}>Add credit</Button>
                    )}
                    {/* post-clear overpay: recording a refund auto-clears a standing
                        write-off, which raises due by writeoff_usd — offer/prefill
                        the amount that will still be over AFTER that clear (matches
                        the server cap) */}
                    {!addingRefund && Number(o.diff_usd) + Number(o.writeoff_usd || 0) < -0.005 && (
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[11px] text-amber-700 border-amber-300"
                        onClick={() => {
                          setAddingRefund(true); setAddingCredit(false);
                          setRefundAmt(String(-(Number(o.diff_usd) + Number(o.writeoff_usd || 0))));
                          setRefundMethod(['eth', 'sol', 'base'].includes(o.payment_rail || '') ? (o.payment_rail as string) : 'zelle');
                          setRefundWallet(''); setCrMsg('');
                        }}>
                        Record refund (over by {fmtUSD(-(Number(o.diff_usd) + Number(o.writeoff_usd || 0)))})
                      </Button>
                    )}
                  </div>
                  {addingCredit && (
                    <div className="flex flex-wrap gap-2 mt-1 items-center">
                      <Input placeholder="Credit $" value={creditAmt} onChange={e => setCreditAmt(e.target.value)} className="h-7 w-24 text-xs" />
                      <Input placeholder="Why is this credited? (audited)" value={creditReason} onChange={e => setCreditReason(e.target.value)} className="h-7 flex-1 min-w-40 text-xs" />
                      <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={submitCredit}>Save</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setAddingCredit(false); setCrMsg(''); }}>Cancel</Button>
                    </div>
                  )}
                  {addingRefund && (
                    <div className="flex flex-wrap gap-2 mt-1 items-center">
                      <Input placeholder="Refund $" value={refundAmt} onChange={e => setRefundAmt(e.target.value)} className="h-7 w-24 text-xs" />
                      <Select value={refundMethod} onValueChange={v => { setRefundMethod(v); setRefundWallet(''); }}>
                        <SelectTrigger className="h-7 w-20 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {/* the refund rail must match the order's rail (server-enforced) */}
                          {(['eth', 'sol', 'base'].includes(o.payment_rail || '') ? [o.payment_rail as string] : ['zelle', 'venmo', 'paypal', 'other'])
                            .map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Select value={refundWallet} onValueChange={setRefundWallet}>
                        <SelectTrigger className="h-7 w-36 text-xs"><SelectValue placeholder="From wallet (opt.)" /></SelectTrigger>
                        <SelectContent>
                          {sheetWallets
                            .filter(w => w.active && (['eth', 'sol', 'base'].includes(refundMethod) ? w.chain === refundMethod : w.chain === 'fiat'))
                            .map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Input placeholder="Tx ref (optional)" value={refundTxRef} onChange={e => setRefundTxRef(e.target.value)} className="h-7 flex-1 min-w-32 text-xs" />
                      <Input placeholder="Why refunded? (audited)" value={refundReason} onChange={e => setRefundReason(e.target.value)} className="h-7 flex-1 min-w-40 text-xs" />
                      <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={submitRefund}>Save</Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setAddingRefund(false); setCrMsg(''); }}>Cancel</Button>
                    </div>
                  )}
                  {crMsg && <p className="text-xs text-red-600 mt-0.5">{crMsg}</p>}
                  {(Number(o.diff_usd) > 0.005 || Number(o.writeoff_usd) > 0) && (
                    <div className="mt-1">
                      {Number(o.pending_payment_count) > 0 && Number(o.writeoff_usd) === 0 ? (
                        <p className="text-[11px] text-muted-foreground">
                          Write-off unavailable while {o.pending_payment_count} payment(s) are pending — verify or reject them first; a pending hash may still turn into money.
                        </p>
                      ) : !woEditing ? (
                        <div className="flex items-center gap-2">
                          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={saving}
                            onClick={() => { setWoEditing(true); setWoAmt(Number(o.writeoff_usd) > 0 ? String(Number(o.writeoff_usd)) : String(Number(o.diff_usd))); setWoReason(''); setWoMsg(''); }}>
                            {Number(o.writeoff_usd) > 0 ? 'Edit write-off' : `Write off ${fmtUSD(o.diff_usd)} short`}
                          </Button>
                          <span className="text-[10px]">forgiven value stays tracked in finances</span>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-2 items-center">
                          <Input placeholder="Amount $" value={woAmt} onChange={e => setWoAmt(e.target.value)} className="h-7 w-24 text-xs" />
                          <Input placeholder="Why write this off? (audited)" value={woReason} onChange={e => setWoReason(e.target.value)} className="h-7 flex-1 min-w-40 text-xs" />
                          <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => saveWriteoff(woAmt, woReason)}>Save</Button>
                          {Number(o.writeoff_usd) > 0 && (
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600" disabled={saving} onClick={() => saveWriteoff('0', '')}>Remove</Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setWoEditing(false); setWoMsg(''); }}>Cancel</Button>
                        </div>
                      )}
                      {woMsg && <p className="text-xs text-red-600 mt-0.5">{woMsg}</p>}
                    </div>
                  )}
                  {o.override_usd != null && <div className="flex justify-between text-violet-700"><span>Manual override active</span><span>{fmtUSD(o.override_usd)}</span></div>}
                </div>
              </div>

              <div>
                <h3 className="font-semibold mb-1">Shipments</h3>
                {shipRows.length === 0 && <p className="text-muted-foreground text-xs">No shipments yet — boxes ship from the Fulfillment page.</p>}
                {shipRows.map(s => (
                  <div key={s.id} className={`py-1 border-b last:border-0 text-xs space-y-0.5 ${s.refund_status === 'SUCCESS' ? 'opacity-50' : ''}`}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusPill value={s.refund_status === 'SUCCESS' ? 'refunded' : (s.finalized_at ? s.status : 'pending')} />
                      {!s.finalized_at && <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title="Unfinished draft — continue or delete it from the Fulfillment page's Ship dialog">draft</span>}
                      {s.tracking_number && <span className="font-mono">{(s.carrier || '').toUpperCase()} {s.tracking_number}</span>}
                      <span className="text-muted-foreground">{(s.items || []).map(i => `${i.sku_code}×${Number(i.qty)}`).join(', ')}</span>
                      {Number(s.label_cost_usd) > 0 && <span className="text-muted-foreground">{fmtUSD(s.label_cost_usd)}</span>}
                      {s.shipped_at && <span className="text-muted-foreground">{fmtDateTime(s.shipped_at)}</span>}
                      {s.refund_status && s.refund_status !== 'SUCCESS' && <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase">refund {s.refund_status}</span>}
                      {s.finalized_at && !s.b44_pushed_at && s.refund_status !== 'SUCCESS' && (
                        <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title="The ordering app has not been told about this shipment yet">not pushed</span>
                      )}
                    </div>
                    {shipPhotos.filter(ph => Number(ph.shipment_id) === s.id).length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {shipPhotos.filter(ph => Number(ph.shipment_id) === s.id).map(ph => (
                          <img key={ph.id} src={ph.thumb_data} alt="package photo" className="h-10 w-10 object-cover rounded border cursor-pointer"
                            onClick={() => enlargeShipPhoto(ph.id, Number(ph.shipment_id))} />
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-1.5">
                      {s.label_url && <a className="underline text-muted-foreground" href={s.label_url} target="_blank" rel="noreferrer">label</a>}
                      {s.finalized_at && !s.b44_pushed_at && s.refund_status !== 'SUCCESS' && o.external_id && (
                        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={saving} onClick={() => pushShipRow(s)}>Push upstream</Button>
                      )}
                    </div>
                  </div>
                ))}
                {shipPushMsg && <p className={`text-xs mt-1 ${shipPushMsg.startsWith('Pushed') ? 'text-green-700' : 'text-amber-700'}`}>{shipPushMsg}</p>}
                {stranded.length > 0 && (
                  <div className="mt-2 rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 p-2 space-y-1.5">
                    <p className="text-xs font-medium text-amber-900 dark:text-amber-200">
                      {stranded.length} package photo(s) saved on this device never finished uploading.
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {stranded.map(s => {
                        return (
                          <span key={s.key} className="relative flex flex-col items-center gap-1">
                            <img src={s.thumb} alt="stranded package photo" className="h-12 w-12 object-cover rounded border cursor-pointer"
                              title={s.shipment_id != null ? `Failed upload for shipment #${s.shipment_id}`
                                : s.recovered ? 'Recovered photo — attachable to the newest live shipment'
                                : 'Pending capture from the Ship dialog — press "recover" to make it attachable here'}
                              onClick={() => setViewShipPhoto(s.full)} />
                            {s.shipment_id == null && !s.recovered ? (
                              <Button size="sm" variant="outline" className="h-5 px-1.5 text-[10px]" disabled={saving}
                                title="Convert this pending capture into a recoverable photo that can be attached from here"
                                onClick={async () => {
                                  const res = await stashMutateIf(s.key, { shipment_id: null, recovered: false }, { ...s, recovered: true });
                                  await refreshStranded();
                                  if (!res.ok) setStrandedMsg('This photo could not be converted (it changed in another tab, or this device’s storage is unavailable) — try again, or reload the page.');
                                  else if (!res.durable) setStrandedMsg('Recovered, but this device’s storage is unavailable — the change survives only while this page stays open.');
                                }}>
                                recover
                              </Button>
                            ) : (
                              <>
                                {s.shipment_id == null && shipRows.filter(r => r.refund_status !== 'SUCCESS').length > 1 && (
                                  <select className="h-5 max-w-[110px] rounded border bg-background text-[10px]"
                                    title="Choose the exact box this photo belongs to"
                                    value={attachTarget[s.key] ?? ''}
                                    onChange={e => setAttachTarget(m => ({ ...m, [s.key]: e.target.value }))}>
                                    <option value="">newest box</option>
                                    {shipRows.filter(r => r.refund_status !== 'SUCCESS').map(r => (
                                      <option key={r.id} value={String(r.id)}>
                                        #{r.id}{r.finalized_at ? '' : ' draft'}{r.tracking_number ? ` ${String(r.tracking_number)}` : ''}
                                      </option>
                                    ))}
                                  </select>
                                )}
                                <Button size="sm" variant="outline" className="h-5 px-1.5 text-[10px]" disabled={saving}
                                  onClick={() => retryStranded(s)}>
                                  {s.shipment_id != null ? 'Retry' : 'Attach'}
                                </Button>
                              </>
                            )}
                            <button className="absolute -top-1.5 -right-1.5 rounded-full bg-background border w-4 h-4 text-[10px] leading-none" title="Discard this saved photo"
                              onClick={async () => {
                                if (!window.confirm('Discard this saved photo? It has not been uploaded anywhere.')) return;
                                const durable = await stashRemove(s.key);
                                await refreshStranded();
                                if (!durable) setStrandedMsg('Discarded from view, but this device’s storage is unavailable — the photo may reappear after a reload; discard it again then.');
                              }}>×</button>
                          </span>
                        );
                      })}
                    </div>
                    {strandedMsg && <p className="text-[11px] text-amber-800 dark:text-amber-300">{strandedMsg}</p>}
                  </div>
                )}
              </div>

              <div>
                <h3 className="font-semibold mb-1">Payments</h3>
                {payments.length === 0 && <p className="text-muted-foreground">No payment records.</p>}
                {payments.map(p => (
                  <div key={p.id} className={`py-1 border-b last:border-0 ${p.status === 'rejected' ? 'opacity-50' : ''}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <StatusPill value={p.status} />
                          <span className="text-xs uppercase text-muted-foreground">{p.method}</span>
                          {p.native_symbol && (
                            <span className="rounded bg-amber-100 text-amber-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase">
                              native {Number(p.native_amount)} {p.native_symbol}
                            </span>
                          )}
                        </div>
                        {p.native_symbol && p.value_at_pay_usd == null && p.status !== 'rejected' && o.override_usd == null && (
                          <div className="text-xs text-amber-700">This payment includes native {p.native_symbol} with no USD value yet. To count it, set an override below for the order's TOTAL received USD — all payments combined (the override replaces, not adds to, the verified sum).</div>
                        )}
                        {p.tx_hash && <div><TxHash method={p.method} hash={p.tx_hash} /></div>}
                        {p.receipt_ref && <div className="text-xs text-muted-foreground">receipt: {p.receipt_ref}</div>}
                        {p.status === 'rejected' && p.notes && <div className="text-xs text-muted-foreground">rejected: {p.notes}</div>}
                        {p.status === 'rejected' && p.tx_hash && (
                          <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                            {reopenTargets(p).map(m => (
                              <Button key={m} size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={saving} onClick={() => reopenOnNetwork(p, m)}>
                                Re-open as {m.toUpperCase()}
                              </Button>
                            ))}
                            {reopenTargets(p).length > 0 && (
                              <span className="text-[10px] text-muted-foreground">wrong-network fix</span>
                            )}
                            {undoingId !== p.id && (
                              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-muted-foreground" disabled={saving}
                                onClick={() => { setUndoingId(p.id); setUndoReason(''); setPayMsg(''); }}>
                                Undo rejection
                              </Button>
                            )}
                          </div>
                        )}
                        {p.status === 'rejected' && undoingId === p.id && (
                          <div className="flex gap-2 mt-1">
                            <Input placeholder="Why was the rejection wrong? (audited)" value={undoReason} onChange={e => setUndoReason(e.target.value)} className="h-7 flex-1 text-xs" />
                            <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => undoRejection(p)}>Confirm undo</Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setUndoingId(null)}>Cancel</Button>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-right whitespace-nowrap">{Number(p.amount_usd) > 0 ? fmtUSD(p.amount_usd) : '—'}</span>
                        {p.status === 'pending' && p.tx_hash && ['eth', 'sol', 'base'].includes(p.method) && (
                          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={saving} onClick={() => verifyNow(p)}>
                            Verify
                          </Button>
                        )}
                        {p.status !== 'rejected' && rejectingId !== p.id && (
                          <Button size="sm" variant="ghost" className="h-6 text-xs text-red-600" onClick={() => { setRejectingId(p.id); setRejectReason(''); setPayMsg(''); }}>
                            Reject
                          </Button>
                        )}
                      </div>
                    </div>
                    {rejectingId === p.id && (
                      <div className="flex gap-2 mt-1">
                        <Input placeholder="Why is this payment wrong? (audited)" value={rejectReason} onChange={e => setRejectReason(e.target.value)} className="h-8 flex-1 text-xs" />
                        <Button size="sm" variant="destructive" className="h-8 text-xs" disabled={saving} onClick={() => rejectPayment(p)}>Confirm</Button>
                        <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setRejectingId(null)}>Cancel</Button>
                      </div>
                    )}
                  </div>
                ))}

                {railMismatch && (
                  <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
                    <p className="text-xs">
                      This order's rail is <span className="font-semibold uppercase">{o.payment_rail}</span> but its verified payment is on{' '}
                      <span className="font-semibold uppercase">{railMismatch}</span> — the ordering app still attributes it to the wrong network
                      (the hash-list push can't fix this; it only syncs hashes).
                    </p>
                    {o.external_id && UPSTREAM_METHOD[railMismatch] ? (
                      <Button size="sm" variant="outline" className="h-7 text-xs mt-1.5" disabled={saving} onClick={() => correctRail(railMismatch)}>
                        Correct rail to {railMismatch.toUpperCase()} + push to ordering app
                      </Button>
                    ) : (
                      <p className="text-xs mt-1 font-medium">
                        No known ordering-app value for {railMismatch.toUpperCase()} — can't correct safely (a local-only change would be reverted by the next import).
                      </p>
                    )}
                  </div>
                )}
                {railMsg && <p className="text-xs mt-1 text-muted-foreground">{railMsg}</p>}

                <div className={`mt-2 rounded p-2 ${o.payment_rail === 'cash' ? 'border border-green-200 bg-green-50/50' : ''}`}>
                  {o.payment_rail === 'cash' && (
                    <p className="text-xs font-medium text-green-900 mb-1.5">Cash order — record the payment here:</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Input placeholder="Amount $" value={cashAmt} onChange={e => setCashAmt(e.target.value)} className="h-8 w-28 text-xs" />
                    <Select value={cashMethod} onValueChange={setCashMethod}>
                      <SelectTrigger className="h-8 w-24 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {['zelle', 'venmo', 'paypal', 'cash', 'other'].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Input placeholder="Receipt # (optional)" value={cashRef} onChange={e => setCashRef(e.target.value)} className="h-8 flex-1 min-w-32 text-xs" />
                    <Button size="sm" className="h-8 text-xs" disabled={saving} onClick={recordCashPayment}>Record payment</Button>
                  </div>
                  {cashMsg && <p className="text-xs mt-1 text-muted-foreground">{cashMsg}</p>}
                </div>

                <div className="flex flex-wrap gap-2 mt-2">
                  <Input placeholder="Add correct tx hash…" value={newHash} onChange={e => setNewHash(e.target.value)} className="h-8 flex-1 min-w-40 font-mono text-xs" />
                  <Select value={newHashMethod} onValueChange={setNewHashMethod}>
                    <SelectTrigger className="h-8 w-20"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['eth', 'sol', 'base'].map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Button size="sm" className="h-8 text-xs" disabled={saving} onClick={addHash}>Add</Button>
                </div>
                {payMsg && <p className="text-xs mt-1 text-muted-foreground">{payMsg}</p>}

                {o.external_id && (settings.base44_token || '') !== '' && (
                  <div className="mt-2 pt-2 border-t">
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" className="h-8 text-xs" disabled={pushing} onClick={pushTxRefs}>
                        {pushing ? 'Pushing…' : 'Push tx refs to ordering app'}
                      </Button>
                      <span className="text-xs text-muted-foreground">replaces the order's hash list upstream with the non-rejected set</span>
                    </div>
                    {pushMsg && <p className="text-xs mt-1 text-muted-foreground">{pushMsg}</p>}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="font-semibold">Admin</h3>
                <div className="flex items-center gap-3">
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['imported', 'verified', 'flagged', 'refunded', 'cancelled'].map(s => (
                        <SelectItem key={s} value={s}>{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <Switch checked={hold} onCheckedChange={setHold} id="hold" />
                    <Label htmlFor="hold" className="text-sm">Hold shipping</Label>
                  </div>
                </div>
                <Textarea placeholder="Admin note" value={adminNote} onChange={e => setAdminNote(e.target.value)} rows={2} />
                <Button size="sm" onClick={save} disabled={saving}>Save</Button>
              </div>

              <div className="space-y-2 rounded border p-3">
                <h3 className="font-semibold text-sm">Reconciliation override</h3>
                <p className="text-xs text-muted-foreground">
                  Forces the effective received amount for this order. Reason is required and the change is logged.
                </p>
                <div className="flex gap-2">
                  <Input placeholder="Amount USD" value={overrideAmt} onChange={e => setOverrideAmt(e.target.value)} className="h-8 w-32" />
                  <Input placeholder="Reason (required)" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} className="h-8 flex-1" />
                  <Button size="sm" variant="outline" onClick={saveOverride} disabled={saving}>Apply</Button>
                </div>
              </div>

              {error && <p className="text-sm text-red-600">{error}</p>}
            </div>
          </>
        )}
      </SheetContent>
      {viewShipPhoto && (
        <Dialog open onOpenChange={v => { if (!v) setViewShipPhoto(null); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader><DialogTitle>Package photo</DialogTitle></DialogHeader>
            <img src={viewShipPhoto} alt="package photo (full size)" className="max-w-full max-h-[70vh] object-contain rounded" />
          </DialogContent>
        </Dialog>
      )}
    </Sheet>
  );
}
