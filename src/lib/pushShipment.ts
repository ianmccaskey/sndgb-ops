/**
 * Push one finalized shipment's facts back to the ordering app (Base44),
 * following the house upstream-mutation discipline (the OrderDetailSheet
 * pushers): (1) a local admin-note trail line is written BEFORE the PUT —
 * a push without a note would be an invisible upstream mutation; (2) the
 * upstream order is read fresh and items[] is READ-MERGE-WRITTEN (a
 * wholesale items replace is how Base44 PUTs work, so only shipped_date
 * may change — every other item field is copied verbatim); (3) the
 * outcome is POSTCONDITION-VERIFIED by re-reading, on every path
 * including thrown transports; (4) only a fully verified push stamps
 * b44_pushed_at (markShipmentPushed) — anything less leaves the amber
 * "not pushed" retry surface alive.
 *
 * What is pushed:
 *  - items[].shipped_date (today, ISO date) for every upstream item whose
 *    LOCAL line is now fully shipped (finalized shipped >= effective) —
 *    matched by product_id = products.external_id; never cleared, never
 *    overwritten if already set upstream.
 *  - a "Shipped <CARRIER> <tracking> — <contents>" line appended to the
 *    upstream notes (skipped if the exact line already exists).
 *  - status: 'shipped' ONLY when the whole order is fully shipped
 *    (every packable line finalized-covered AND no vendor-direct line
 *    outstanding). Partial shipments set 'partially_shipped' — the
 *    ordering app's own partial vocabulary, observed live 2026-08-30 —
 *    but NEVER over a protected status (shipped/delivered/another
 *    partial marker/any terminal cancel-refund state): a push must not
 *    downgrade what the other admin recorded, and if she flips the
 *    status mid-push the verification fails and the idempotent retry
 *    re-reads and defers to her value.
 */
import { getB44Order, updateB44Order } from '@/lib/base44';
import type { B44Config, B44Order, B44OrderItem } from '@/lib/base44';

export type PushPackableLine = {
  order_item_id: number;
  product_external_id: string | null;
  sku_code: string;
  effective_qty: string;
  shipped_qty: string;
  direct_ship: boolean;
  direct_fulfilled_at: string | null;
  digital: boolean;
};

export type PushShipmentDeps = {
  cfg: B44Config;
  externalId: string;            // Base44 order id ('' = never imported with one)
  orderId: number;               // local order id
  orderNumber: string;
  shipmentId: number;
  // the shipment's push_epoch when this push STARTED — the stamp CASes on
  // it, so a digital-flip invalidation landing mid-push wins
  pushEpoch: number;
  carrier: string;
  tracking: string;
  shippedItems: { sku: string; qty: string }[];   // THIS box's contents (note text)
  packable: PushPackableLine[];  // FRESH getPackableItems rows, fetched by the caller AT PUSH TIME
  userName: string;
  appendNote: (params: Record<string, unknown>) => Promise<unknown>;
  markPushed: (params: Record<string, unknown>) => Promise<unknown>;
};

export type PushOutcome = { ok: boolean; message: string };

// the operator's LOCAL calendar date (en-CA renders YYYY-MM-DD): an
// evening shipment must not be stamped with tomorrow's UTC date in the
// ordering app or the note trail
const today = () => new Date().toLocaleDateString('en-CA');

export async function pushShipmentUpstream(d: PushShipmentDeps): Promise<PushOutcome> {
  if (!d.cfg.token) return { ok: false, message: 'Ordering-app push skipped — no Base44 token in Settings. The shipment is saved; use "Push upstream" once the token is set.' };
  if (!d.externalId) return { ok: false, message: 'Ordering-app push skipped — this order has no ordering-app id (added locally?). The shipment is saved.' };

  // ONE ship date per invocation: awaited network calls sit between the
  // note writes and the shipped_date merge, and a push crossing local
  // midnight must not record contradictory dates for the same shipment
  const shipDate = today();

  // fully-shipped is computed from the FRESH packable rows the caller just
  // loaded — never from stale modal props. DIGITAL lines (COA certificates)
  // are excluded entirely: they deliver digitally, never gate the order's
  // shipped status, and never receive an upstream shipped_date from here.
  const packableLines = d.packable.filter(l => !l.direct_ship && !l.digital && Number(l.effective_qty) > 0);
  const directLines = d.packable.filter(l => l.direct_ship && !l.digital);
  // zero-PHYSICAL orders are vacuously fully shipped (the order must have
  // at least one line of any kind): an order whose only lines are digital
  // has nothing left for fulfillment to withhold status on. In practice a
  // push only runs after a shipment, which requires a physical line — the
  // vacuous branch covers mid-life transitions (e.g. the last physical
  // line removed after an earlier box).
  const fullyShipped =
    d.packable.length > 0
    && packableLines.every(l => Number(l.shipped_qty) >= Number(l.effective_qty))
    && directLines.every(l => l.direct_fulfilled_at != null);

  const contents = d.shippedItems.map(i => `${i.sku} x ${i.qty}`).join(', ');
  const trackLine = `Shipped ${d.carrier.toUpperCase()} ${d.tracking}${contents ? ` — ${contents}` : ''} (${shipDate})`;

  // the external product ids whose local lines are NOW fully shipped —
  // these upstream items get shipped_date
  const shipExternalIds = new Set(
    packableLines
      .filter(l => l.product_external_id && Number(l.shipped_qty) >= Number(l.effective_qty))
      .map(l => l.product_external_id as string));

  // (1) local trail BEFORE the upstream mutation — refusing to write it
  // aborts the push entirely
  try {
    await d.appendNote({
      order_id: d.orderId,
      note: `[${shipDate}] ${d.userName} pushed shipment upstream: ${d.carrier.toUpperCase()} ${d.tracking}; items ${contents || '(none listed)'}; upstream status ${fullyShipped ? "-> 'shipped'" : "-> 'partially_shipped' (unless already shipped/terminal there)"}.`,
      detail: JSON.stringify({ shipment_id: d.shipmentId, tracking: d.tracking, fully_shipped: fullyShipped }),
      actor: d.userName,
    });
  } catch {
    return { ok: false, message: 'Push NOT sent — the local audit note could not be written, and a push without a local trail is not allowed. Retry.' };
  }

  const followUp = async (line: string) => {
    try {
      await d.appendNote({ order_id: d.orderId, note: `[${shipDate}] ${line}`, detail: JSON.stringify({ shipment_id: d.shipmentId }), actor: d.userName });
    } catch { /* the primary outcome message still reaches the operator */ }
  };

  // (2) read-merge-write
  let upstream: B44Order;
  try {
    upstream = await getB44Order(d.cfg, d.externalId);
  } catch (e: unknown) {
    const m = e instanceof Error ? e.message : 'read failed';
    await followUp(`PUSH ABORTED before write: could not read the upstream order (${m}).`);
    return { ok: false, message: `Push aborted — could not read the upstream order (${m}). The shipment is saved; retry the push.` };
  }

  const upstreamItems = Array.isArray(upstream.items) ? upstream.items : [];
  const mergedItems: B44OrderItem[] = upstreamItems.map(it => {
    const pid = String(it.product_id ?? '');
    if (pid && shipExternalIds.has(pid) && !it.shipped_date) {
      return { ...it, shipped_date: shipDate };
    }
    return it;
  });
  const intendedDates = upstreamItems.filter(it => {
    const pid = String(it.product_id ?? '');
    return pid && shipExternalIds.has(pid) && !it.shipped_date;
  }).length;

  const upstreamNotes = String(upstream.notes ?? '');
  const mergedNotes = upstreamNotes.includes(trackLine)
    ? upstreamNotes
    : (upstreamNotes ? `${upstreamNotes}\n${trackLine}` : trackLine);

  // partial pushes set the ordering app's own partial marker — but never
  // over a status that already says shipped-or-beyond or terminal: the
  // other admin's 'shipped'/'delivered' (or a cancel/refund) must not be
  // downgraded by a box recorded late, and an existing 'partially_shipped'
  // needs no churn ('shipped' in the regex also covers it).
  const upstreamStatus = String(upstream.status ?? '').trim();
  const statusProtected = /shipped|delivered|cancel|refund|reject|void|denied/i.test(upstreamStatus);
  const setPartial = !fullyShipped && !statusProtected;

  const fields: Record<string, unknown> = { items: mergedItems, notes: mergedNotes };
  if (fullyShipped) fields.status = 'shipped';
  else if (setPartial) fields.status = 'partially_shipped';

  let putError: string | null = null;
  try {
    await updateB44Order(d.cfg, d.externalId, fields);
  } catch (e: unknown) {
    // do NOT trust a thrown transport: the PUT may still have landed —
    // fall through to verification exactly like the house pushers
    putError = e instanceof Error ? e.message : 'update failed';
  }

  // (3) postcondition verification on EVERY outcome
  try {
    const after = await getB44Order(d.cfg, d.externalId);
    const afterItems = Array.isArray(after.items) ? after.items : [];
    const datesLanded = afterItems.filter(it => {
      const pid = String(it.product_id ?? '');
      return pid && shipExternalIds.has(pid) && !!it.shipped_date;
    }).length;
    const expectDates = shipExternalIds.size === 0 ? 0
      : afterItems.filter(it => shipExternalIds.has(String(it.product_id ?? ''))).length;
    const noteOk = String(after.notes ?? '').includes(trackLine);
    const statusOk = fullyShipped
      ? String(after.status ?? '') === 'shipped'
      : !setPartial || String(after.status ?? '') === 'partially_shipped';

    if (noteOk && statusOk && datesLanded >= expectDates) {
      // (4) verified — stamp. The stamp is NOT best-effort when this push
      // set status='shipped': the same statement writes the immutable
      // audit evidence the digital-reversal guard depends on, so a
      // refused/failed stamp on a status-setting push must surface as a
      // retryable failure, never as success (the retry is idempotent —
      // verification passes again and only the stamp re-runs).
      let stamped = false;
      try {
        const res = await d.markPushed({
          shipment_id: d.shipmentId, actor: d.userName, expected_push_epoch: d.pushEpoch,
          pushed: JSON.stringify({ tracking: d.tracking, carrier: d.carrier, shipped_date_items: datesLanded, status_set: fullyShipped ? 'shipped' : setPartial ? 'partially_shipped' : null }),
        }) as unknown[] | null;
        stamped = Array.isArray(res) ? res.length > 0 : !!res;
      } catch { stamped = false; }
      if (!stamped && fullyShipped) {
        await followUp('PUSH VERIFIED upstream but the local completion record did not save (a concurrent change may have intervened) — push again to finish recording.');
        return { ok: false, message: "Upstream verified (status 'shipped' landed) but the LOCAL completion record did not save — use \"Push upstream\" once more to finish recording; the retry is idempotent." };
      }
      return { ok: true, message: `Pushed to the ordering app: tracking noted${intendedDates > 0 ? `, ${intendedDates} item(s) marked shipped` : ''}${fullyShipped ? ", status -> 'shipped'" : setPartial ? ", status -> 'partially_shipped'" : ` (status unchanged — upstream already "${upstreamStatus}")`}.` };
    }
    const what = [
      noteOk ? null : 'tracking note missing',
      statusOk ? null : `status not '${fullyShipped ? 'shipped' : 'partially_shipped'}'`,
      datesLanded >= expectDates ? null : 'some shipped_date entries missing',
    ].filter(Boolean).join(', ');
    await followUp(`PUSH PARTIAL: verification found ${what}${putError ? ` (transport also reported: ${putError})` : ''} — retry the push.`);
    return { ok: false, message: `Push PARTIAL — upstream verification found: ${what}. The shipment is saved locally; use "Push upstream" to retry.` };
  } catch {
    await followUp(`PUSH UNKNOWN: the update ${putError ? `threw (${putError})` : 'was sent'} and the verifying re-read failed — the upstream order may or may not be updated. Retry the push; it is idempotent (merge skips already-set fields).`);
    return { ok: false, message: 'Push outcome UNKNOWN — could not verify the upstream order. The push is idempotent; use "Push upstream" to retry.' };
  }
}

// ---------------------------------------------------------------------------

export type PushDatesLine = {
  /** the ordering-app product id (campaign_product_links.external_id) */
  productExternalId: string;
  /** YYYY-MM-DD the line left — the box date, or the vendor-shipped stamp */
  date: string;
  /** one note fragment, e.g. "Vendor shipped UPS 1Z… — R30 x 30" */
  label: string;
};

export type PushDatesArgs = {
  cfg: B44Config;
  externalId: string;
  orderId: number;
  orderNumber: string;
  /** items to date; may be EMPTY when only the order's completion status is owed */
  lines: PushDatesLine[];
  /** every non-digital line of the order is now covered here (boxes + vendor stamps) */
  fullyShipped: boolean;
  actor: string;
  appendNote: (params: { order_id: number; note: string; detail: string; actor: string }) => Promise<unknown>;
};

export type PushDatesOutcome = PushOutcome & {
  skipped?: boolean;
  /** the order-level status this write VERIFIED upstream, when it set one */
  statusSet?: 'shipped' | 'partially_shipped' | null;
};

/**
 * Write ship dates the ordering app is missing for lines that ALREADY
 * left from here: vendor-direct lines marked "Vendor shipped" (which no
 * other path pushes), and packed lines whose box push left them undated
 * (a partial at push time, a later quantity edit) — and, with no lines at
 * all, the order's completion status once every line is covered here.
 * Used by the auto-adopt pass (src/lib/autoAdopt.ts). Same discipline as
 * pushShipmentUpstream: local trail line first, read-merge-write of
 * items[] (only shipped_date on the named items, never over one already
 * set), a note line appended once, status 'shipped' only when the whole
 * order is covered (never over 'delivered' — the other admin's later
 * fact stands) and otherwise 'partially_shipped' never over a protected
 * status, then a verifying re-read. The ordering app's own shipped_date
 * and status are the idempotency markers: the next run sees them set and
 * leaves the order alone. The caller records the durable completion
 * evidence (logUpstreamCompletion) when statusSet is 'shipped'.
 */
export async function pushShippedDatesUpstream(d: PushDatesArgs): Promise<PushDatesOutcome> {
  if (!d.cfg.token) return { ok: false, skipped: true, message: 'ordering-app write-back skipped — no token in Settings' };
  if (!d.externalId || (d.lines.length === 0 && !d.fullyShipped)) return { ok: false, skipped: true, message: 'nothing to write back' };
  const today = new Date().toLocaleDateString('en-CA');
  const labels = d.lines.map(l => l.label).join('; ');
  const noteLine = d.lines.length > 0 ? `Shipped per Ops app — ${labels} (${today})` : '';

  try {
    await d.appendNote({
      order_id: d.orderId,
      note: `[${today}] ${d.actor} ${d.lines.length > 0 ? `wrote ship dates to the ordering app: ${labels}` : 'confirmed the order complete in the ordering app (every line shipped here)'}; upstream status ${d.fullyShipped ? "-> 'shipped' (unless already delivered)" : "-> 'partially_shipped' (unless already shipped/terminal there)"}.`,
      detail: JSON.stringify({ lines: d.lines, fully_shipped: d.fullyShipped }),
      actor: d.actor,
    });
  } catch {
    return { ok: false, message: 'write-back NOT sent — the local audit note could not be written, and an upstream write without a local trail is not allowed' };
  }

  let upstream: B44Order;
  try {
    upstream = await getB44Order(d.cfg, d.externalId);
  } catch (e: unknown) {
    return { ok: false, message: `write-back aborted — could not read the ordering-app order (${e instanceof Error ? e.message : 'read failed'})` };
  }
  const upstreamStatus = String(upstream.status ?? '').trim();
  if (/cancel|refund|reject|void|denied/i.test(upstreamStatus)) {
    return { ok: false, skipped: true, message: `write-back skipped — the ordering app now shows the order "${upstreamStatus}"` };
  }
  const dateByPid = new Map(d.lines.map(l => [l.productExternalId, l.date] as const));
  const upstreamItems = Array.isArray(upstream.items) ? upstream.items : [];
  let intended = 0;
  const mergedItems: B44OrderItem[] = upstreamItems.map(it => {
    const pid = String(it.product_id ?? '');
    const date = dateByPid.get(pid);
    if (date && !it.shipped_date) { intended++; return { ...it, shipped_date: date }; }
    return it;
  });
  const upstreamNotes = String(upstream.notes ?? '');
  const noteAlready = !noteLine || upstreamNotes.includes(noteLine);
  const mergedNotes = noteAlready ? upstreamNotes : (upstreamNotes ? `${upstreamNotes}\n${noteLine}` : noteLine);
  const delivered = /delivered/i.test(upstreamStatus);
  const statusProtected = /shipped|delivered/i.test(upstreamStatus);
  // the status this write intends: 'shipped' when the order is covered
  // here (unless the other admin already recorded delivery — a later
  // fact than ours), 'partially_shipped' for a dated line on an order
  // not yet covered unless its status already says shipped-or-beyond
  const statusSet: PushDatesOutcome['statusSet'] = d.fullyShipped ? (delivered ? null : 'shipped') : (statusProtected ? null : 'partially_shipped');
  const statusChanges = !!statusSet && statusSet !== upstreamStatus;
  if (intended === 0 && !statusChanges && noteAlready) {
    return { ok: true, statusSet, message: `the ordering app already shows it (${upstreamStatus}) — nothing to write` };
  }
  const fields: Record<string, unknown> = { items: mergedItems, notes: mergedNotes };
  if (statusSet) fields.status = statusSet;

  let putError: string | null = null;
  try {
    await updateB44Order(d.cfg, d.externalId, fields);
  } catch (e: unknown) {
    putError = e instanceof Error ? e.message : 'update failed';
  }

  try {
    const after = await getB44Order(d.cfg, d.externalId);
    const afterItems = Array.isArray(after.items) ? after.items : [];
    const undated = afterItems.filter(it => dateByPid.has(String(it.product_id ?? '')) && !it.shipped_date).length;
    const noteOk = !noteLine || String(after.notes ?? '').includes(noteLine);
    const afterStatus = String(after.status ?? '').trim();
    const statusOk = statusSet ? afterStatus === statusSet : afterStatus === upstreamStatus;
    if (undated === 0 && noteOk && statusOk) {
      return { ok: true, statusSet, message: `ordering app updated: ${intended} item${intended === 1 ? '' : 's'} dated${labels ? ` (${labels})` : ''}${statusChanges ? `, status -> '${statusSet}'` : delivered ? ' (delivered there, kept)' : ''}` };
    }
    const what = [undated > 0 ? `${undated} item(s) still undated` : null, noteOk ? null : 'note missing', statusOk ? null : `status is '${afterStatus}'`].filter(Boolean).join(', ');
    return { ok: false, message: `write-back partial — the ordering app shows ${what}${putError ? ` (transport: ${putError})` : ''}; the next run retries` };
  } catch {
    return { ok: false, message: `write-back outcome unknown — the update ${putError ? `threw (${putError})` : 'was sent'} and the verifying re-read failed; the next run retries (idempotent)` };
  }
}
