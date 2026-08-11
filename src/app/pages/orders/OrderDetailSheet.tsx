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
import setOrderItemComp from '@/actions/orders/setOrderItemComp';
import updateOrderRail from '@/actions/orders/updateOrderRail';
import appendOrderAdminNote from '@/actions/orders/appendOrderAdminNote';
import { shortHash } from '@/lib/explorer';
import { B44_DEFAULT_APP_ID, getB44Order, updateB44Order } from '@/lib/base44';
import { normalizeTxHash, canonicalTxRef } from '@/lib/parseOrderImport';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtDateTime } from '@/lib/fmt';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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
  processor_fee_usd: string; total_usd: string; placed_at: string | null;
  customer_note: string | null; admin_note: string | null; hold_shipping: boolean;
  customer_name: string; customer_email: string | null;
  recon_status: string | null; received_usd: string | null; override_usd: string | null;
  effective_received_usd: string | null; diff_usd: string | null;
  comp_usd: string | null; due_usd: string | null;
};

type ItemRow = {
  id: number; qty: string; unit_price_usd: string; line_total_usd: string;
  comp_qty: string; comp_reason: string | null; comp_value_usd: string;
  sku_code: string; product_name: string;
};
type PaymentRow = {
  id: number; method: string; tx_hash: string | null; receipt_ref: string | null;
  amount_usd: string; status: string; verify_source: string | null; verified_at: string | null; notes: string | null;
  native_amount: string | null; native_symbol: string | null; value_at_pay_usd: string | null;
};

export function OrderDetailSheet({ orderId, onClose }: { orderId: number | null; onClose: () => void }) {
  const { userName, settings } = useApp();
  const open = orderId != null;
  const [rawOrder, , , reloadOrder] = useLoadAction(getOrder, [orderId], { order_id: orderId }, { enabled: open });
  const [rawItems, , , reloadItems] = useLoadAction(getOrderItems, [orderId], { order_id: orderId }, { enabled: open });
  const [rawPayments, , , reloadPayments] = useLoadAction(listOrderPayments, [orderId], { order_id: orderId }, { enabled: open });
  const o = firstRow<OrderRow>(rawOrder);
  const items = rows<ItemRow>(rawItems);
  const payments = rows<PaymentRow>(rawPayments);

  const [doUpdate] = useMutateAction(updateOrderAdmin);
  const [doOverride] = useMutateAction(addOverride);
  const [doPayStatus] = useMutateAction(updatePaymentStatus);
  const [doAddHash] = useMutateAction(addPaymentHash);
  const [doGetTxRefs] = useMutateAction(getOrderTxRefs);
  const [doAppendNote] = useMutateAction(appendOrderAdminNote);
  const [doCashPay] = useMutateAction(addManualPaymentByNumber);
  const [doReopenNetwork] = useMutateAction(reopenPaymentOnNetwork);
  const [doSetComp] = useMutateAction(setOrderItemComp);
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

  // comped (free) items
  const [compingId, setCompingId] = useState<number | null>(null);
  const [compQty, setCompQty] = useState('');
  const [compReason, setCompReason] = useState('');
  const [compMsg, setCompMsg] = useState('');

  // payment corrections
  const [rejectingId, setRejectingId] = useState<number | null>(null);
  const [rejectReason, setRejectReason] = useState('');
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
      setNewHash(''); setPayMsg(''); setPushMsg('');
      setNewHashMethod(o.payment_rail === 'sol' || o.payment_rail === 'base' ? o.payment_rail : 'eth');
      setCashAmt(''); setCashRef(''); setCashMsg('');
      setCashMethod(o.payment_rail === 'cash' ? 'zelle' : 'other');
      setCompingId(null); setCompQty(''); setCompReason(''); setCompMsg('');
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
        setPayMsg(`Re-opened as pending on ${method.toUpperCase()} — run Verify on the Reconciliation page to confirm it on-chain.`);
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

  // Comp (free product) on one line: recon then owes billed − comp value,
  // and P&L books the give-away. Validation mirrors the SQL guards so the
  // refusal message is immediate instead of a silent no-row result.
  const saveComp = async (it: ItemRow, qtyStr: string, reason: string) => {
    if (!o) return;
    const clearing = Number(qtyStr) === 0;
    if (!/^\d+(?:\.\d{1,2})?$/.test(qtyStr.trim())) { setCompMsg('Comp qty must be a number with at most 2 decimals.'); return; }
    if (Number(qtyStr) > Number(it.qty)) { setCompMsg(`Can't comp more than the ${it.qty} ordered.`); return; }
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
      else { setPayMsg('Added as pending — run Verify on the Reconciliation page to confirm it on-chain.'); setNewHash(''); }
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
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="truncate">{it.sku_code} × {it.qty}</span>
                        {Number(it.comp_qty) > 0 && (
                          <span
                            className="rounded bg-green-100 text-green-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap"
                            title={it.comp_reason || ''}
                          >
                            comp {Number(it.comp_qty)} · −{fmtUSD(it.comp_value_usd)}
                          </span>
                        )}
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span>{fmtUSD(it.line_total_usd)}</span>
                        {compingId !== it.id && (
                          <Button
                            size="sm" variant="ghost" className="h-5 px-1.5 text-[11px] text-muted-foreground"
                            onClick={() => { setCompingId(it.id); setCompQty(String(Number(it.comp_qty) || '')); setCompReason(it.comp_reason || ''); setCompMsg(''); }}
                          >
                            {Number(it.comp_qty) > 0 ? 'Edit comp' : 'Comp'}
                          </Button>
                        )}
                      </span>
                    </div>
                    {compingId === it.id && (
                      <div className="flex flex-wrap gap-2 mt-1 items-center">
                        <Input placeholder={`Free units (max ${it.qty})`} value={compQty} onChange={e => setCompQty(e.target.value)} className="h-7 w-32 text-xs" />
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
                <Separator className="my-2" />
                <div className="space-y-0.5 text-muted-foreground">
                  <div className="flex justify-between"><span>Subtotal</span><span>{fmtUSD(o.subtotal_usd)}</span></div>
                  {Number(o.tip_usd) > 0 && <div className="flex justify-between"><span>Tip</span><span>{fmtUSD(o.tip_usd)}</span></div>}
                  <div className="flex justify-between"><span>Admin fee</span><span>{fmtUSD(o.admin_fee_usd)}</span></div>
                  <div className="flex justify-between"><span>Shipping fee</span><span>{fmtUSD(o.shipping_fee_usd)}</span></div>
                  {Number(o.processor_fee_usd) > 0 && <div className="flex justify-between"><span>Processor fee</span><span>{fmtUSD(o.processor_fee_usd)}</span></div>}
                  <div className="flex justify-between font-semibold text-foreground"><span>Total</span><span>{fmtUSD(o.total_usd)}</span></div>
                  {Number(o.comp_usd) > 0 && (
                    <>
                      <div className="flex justify-between text-green-700"><span>Comped items</span><span>−{fmtUSD(o.comp_usd)}</span></div>
                      <div className="flex justify-between font-semibold text-foreground"><span>Due</span><span>{fmtUSD(o.due_usd)}</span></div>
                    </>
                  )}
                  <div className="flex justify-between"><span>Received (effective)</span><span>{fmtUSD(o.effective_received_usd)}</span></div>
                  {o.override_usd != null && <div className="flex justify-between text-violet-700"><span>Manual override active</span><span>{fmtUSD(o.override_usd)}</span></div>}
                </div>
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
                        {p.status === 'rejected' && reopenTargets(p).length > 0 && (
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {reopenTargets(p).map(m => (
                              <Button key={m} size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={saving} onClick={() => reopenOnNetwork(p, m)}>
                                Re-open as {m.toUpperCase()}
                              </Button>
                            ))}
                            <span className="text-[10px] text-muted-foreground">wrong-network fix — goes back to pending</span>
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-right whitespace-nowrap">{Number(p.amount_usd) > 0 ? fmtUSD(p.amount_usd) : '—'}</span>
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
    </Sheet>
  );
}
