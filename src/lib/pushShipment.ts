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
 *    outstanding). Partial shipments leave the upstream status untouched:
 *    the app's status vocabulary for partials is unconfirmed, and pushing
 *    an unknown string could break the ordering app's UI.
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
};

export type PushShipmentDeps = {
  cfg: B44Config;
  externalId: string;            // Base44 order id ('' = never imported with one)
  orderId: number;               // local order id
  orderNumber: string;
  shipmentId: number;
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
  // loaded — never from stale modal props
  const packableLines = d.packable.filter(l => !l.direct_ship && Number(l.effective_qty) > 0);
  const directLines = d.packable.filter(l => l.direct_ship);
  const fullyShipped =
    (packableLines.length + directLines.length) > 0
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
      note: `[${shipDate}] ${d.userName} pushed shipment upstream: ${d.carrier.toUpperCase()} ${d.tracking}; items ${contents || '(none listed)'}; upstream status ${fullyShipped ? "-> 'shipped'" : 'unchanged (partial)'}.`,
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

  const fields: Record<string, unknown> = { items: mergedItems, notes: mergedNotes };
  if (fullyShipped) fields.status = 'shipped';

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
    const statusOk = !fullyShipped || String(after.status ?? '') === 'shipped';

    if (noteOk && statusOk && datesLanded >= expectDates) {
      // (4) verified — stamp; an already-stamped refusal is fine
      try {
        await d.markPushed({
          shipment_id: d.shipmentId, actor: d.userName,
          pushed: JSON.stringify({ tracking: d.tracking, carrier: d.carrier, shipped_date_items: datesLanded, status_set: fullyShipped ? 'shipped' : null }),
        });
      } catch { /* stamp failure keeps the retry surface — safe direction */ }
      return { ok: true, message: `Pushed to the ordering app: tracking noted${intendedDates > 0 ? `, ${intendedDates} item(s) marked shipped` : ''}${fullyShipped ? ", status -> 'shipped'" : ' (status unchanged — partial)'}.` };
    }
    const what = [
      noteOk ? null : 'tracking note missing',
      statusOk ? null : "status not 'shipped'",
      datesLanded >= expectDates ? null : 'some shipped_date entries missing',
    ].filter(Boolean).join(', ');
    await followUp(`PUSH PARTIAL: verification found ${what}${putError ? ` (transport also reported: ${putError})` : ''} — retry the push.`);
    return { ok: false, message: `Push PARTIAL — upstream verification found: ${what}. The shipment is saved locally; use "Push upstream" to retry.` };
  } catch {
    await followUp(`PUSH UNKNOWN: the update ${putError ? `threw (${putError})` : 'was sent'} and the verifying re-read failed — the upstream order may or may not be updated. Retry the push; it is idempotent (merge skips already-set fields).`);
    return { ok: false, message: 'Push outcome UNKNOWN — could not verify the upstream order. The push is idempotent; use "Push upstream" to retry.' };
  }
}
