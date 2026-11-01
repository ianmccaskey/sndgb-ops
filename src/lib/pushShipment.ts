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
import { isHandSetDate } from '@/lib/autoAdopt';

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
  /** claimShipmentPush: claim / renew this box's push under the order lock (zero rows = refused) */
  claimPush: (params: Record<string, unknown>) => Promise<unknown>;
  /** releaseShipmentPush: give the claim back when the push ends without its stamp */
  releasePush: (params: Record<string, unknown>) => Promise<unknown>;
};

export type PushOutcome = { ok: boolean; message: string };

const claimedAtOf = (res: unknown): string =>
  Array.isArray(res) && res.length > 0 ? String((res[0] as { claimed_at?: unknown }).claimed_at ?? '') : '';

// the operator's LOCAL calendar date (en-CA renders YYYY-MM-DD): an
// evening shipment must not be stamped with tomorrow's UTC date in the
// ordering app or the note trail
const today = () => new Date().toLocaleDateString('en-CA');

export async function pushShipmentUpstream(d: PushShipmentDeps): Promise<PushOutcome> {
  if (!d.cfg.token) return { ok: false, message: 'Ordering-app push skipped — no Base44 token in Settings. The shipment is saved; use "Push upstream" once the token is set.' };
  if (!d.externalId) return { ok: false, message: 'Ordering-app push skipped — this order has no ordering-app id (added locally?). The shipment is saved.' };

  // (0) CLAIM the box before anything is written, local or upstream
  // (1790103200): under the order lock a cancelled / voided / already
  // pushed / re-epoched box refuses, and while the claim is held the box
  // cannot be cancelled — so this push can never land after a cancel's
  // ordering-app reset. The renewal right before the PUT also marks the
  // write DISPATCHED (push_dispatched_at): a request that went out may
  // still land whatever this tab hears back (a thrown transport, a
  // negative re-read), so only the verified stamp clears that mark —
  // the cancel stays refused until then or for 10 minutes. The claim
  // itself is given back on every ending without the stamp; a retry may
  // take it over at once.
  let claimedAt: string;
  try {
    claimedAt = claimedAtOf(await d.claimPush({ shipment_id: d.shipmentId, expected_push_epoch: d.pushEpoch, prior_claimed_at: '', actor: d.userName }));
  } catch {
    return { ok: false, message: 'Push NOT sent — the push could not be claimed (network error). The shipment is saved; retry the push.' };
  }
  if (!claimedAt) {
    return { ok: false, message: 'Push NOT sent — this box was cancelled, refunded or already pushed, or changed since it was read. Nothing was written; retry if it still shows "not pushed".' };
  }
  const lease = { claimedAt, stamped: false };
  try {
    return await pushClaimed(d, lease);
  } finally {
    if (!lease.stamped) {
      try { await d.releasePush({ shipment_id: d.shipmentId, claimed_at: lease.claimedAt }); } catch { /* it lapses in 10 minutes */ }
    }
  }
}

async function pushClaimed(d: PushShipmentDeps, lease: { claimedAt: string; stamped: boolean }): Promise<PushOutcome> {
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

  // renew the claim right before the PUT: a box cancelled or voided since
  // the claim — or a claim that lapsed and another tab took — stops here,
  // with nothing written upstream
  let renewed = '';
  try {
    renewed = claimedAtOf(await d.claimPush({ shipment_id: d.shipmentId, expected_push_epoch: d.pushEpoch, prior_claimed_at: lease.claimedAt, actor: d.userName }));
  } catch { renewed = ''; }
  if (!renewed) {
    await followUp('PUSH ABORTED before write: the box was cancelled, voided or pushed elsewhere (or this push lost its claim) while the push was being prepared — nothing written upstream.');
    return { ok: false, message: 'Push NOT sent — the box changed (cancelled, voided or pushed elsewhere) while the push was being prepared. Nothing was written to the ordering app.' };
  }
  lease.claimedAt = renewed;

  // (the renewal above stamped push_dispatched_at: from here the request
  // may land whatever this tab hears back, and only the stamp clears it)
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
          // prior_status: what a later reset of this box restores
          // (resetVoidedShipmentUpstream) when nothing else shipped
          pushed: JSON.stringify({ tracking: d.tracking, carrier: d.carrier, shipped_date_items: datesLanded, status_set: fullyShipped ? 'shipped' : setPartial ? 'partially_shipped' : null, prior_status: upstreamStatus }),
        }) as unknown[] | null;
        stamped = Array.isArray(res) ? res.length > 0 : !!res;
      } catch { stamped = false; }
      // the stamp cleared the claim and the dispatch mark; anything less
      // gives the claim back and leaves the dispatch mark to lapse
      lease.stamped = stamped;
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
  /**
   * what this app has shipped per ordering-app product id (digital lines
   * flagged) — the completion status is set only when EVERY item on the
   * freshly read upstream order is covered by it, so a line or quantity
   * added upstream since the last import can never be called shipped
   */
  coverage: Record<string, { covered: number; digital: boolean }>;
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
 * set), a note line appended once (also on a status-only write — it is
 * the recovery marker), status 'shipped' only when the whole
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

  // READ first (a read is not a mutation): what is written depends on the
  // order as it is NOW — an item whose upstream quantity grew past what
  // shipped here is left undated, and the local trail line below names
  // exactly what will be written
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
  const upstreamItems = Array.isArray(upstream.items) ? upstream.items : [];
  // upstream quantity per product (an order may list a product twice)
  const upQty = new Map<string, number>();
  for (const it of upstreamItems) {
    const pid = String(it.product_id ?? '');
    const q = Number(it.quantity ?? 0);
    if (pid && q > 0) upQty.set(pid, (upQty.get(pid) ?? 0) + q);
  }
  // a product is coverable when what shipped here covers its WHOLE
  // upstream quantity (digital lines always): only such items get a date
  const coverable = (pid: string) => {
    const c = d.coverage[pid];
    return !!c && (c.digital || c.covered + 1e-9 >= (upQty.get(pid) ?? 0));
  };
  const dateLines = d.lines.filter(l => coverable(l.productExternalId));
  const heldBack = d.lines.filter(l => !coverable(l.productExternalId)).map(l => l.label);
  const uncoveredUpstream = [...upQty.keys()].filter(pid => !coverable(pid))
    .map(pid => `${String(upstreamItems.find(it => String(it.product_id ?? '') === pid)?.product_name ?? pid)} x${upQty.get(pid)}`);
  const complete = d.fullyShipped && uncoveredUpstream.length === 0;
  const dateByPid = new Map(dateLines.map(l => [l.productExternalId, l.date] as const));
  let intended = 0;
  const mergedItems: B44OrderItem[] = upstreamItems.map(it => {
    const pid = String(it.product_id ?? '');
    const date = dateByPid.get(pid);
    if (date && !it.shipped_date) { intended++; return { ...it, shipped_date: date }; }
    return it;
  });
  const labels = dateLines.map(l => l.label).join('; ');
  // ALWAYS a note line, even with nothing to date: it is the stable
  // marker a later run recovers the durable completion evidence from
  // (autoAdopt: "Shipped per Ops app" upstream + status shipped + no
  // audit row → write the row), so a PUT that landed before a failed
  // verification or a failed audit insert is never lost
  const noteLine = dateLines.length > 0
    ? `Shipped per Ops app — ${labels} (${today})`
    : `Shipped per Ops app — order complete, every line shipped (${today})`;
  const upstreamNotes = String(upstream.notes ?? '');
  const noteAlready = upstreamNotes.includes(noteLine);
  const mergedNotes = noteAlready ? upstreamNotes : (upstreamNotes ? `${upstreamNotes}\n${noteLine}` : noteLine);
  const delivered = /delivered/i.test(upstreamStatus);
  const statusProtected = /shipped|delivered/i.test(upstreamStatus);
  // the status this write intends: 'shipped' when the order is covered
  // here AND upstream (unless the other admin already recorded delivery —
  // a later fact than ours), 'partially_shipped' for a dated line on an
  // order not yet covered unless its status already says shipped-or-beyond
  const statusSet: PushDatesOutcome['statusSet'] = complete ? (delivered ? null : 'shipped') : (statusProtected || dateLines.length === 0 ? null : 'partially_shipped');
  const statusChanges = !!statusSet && statusSet !== upstreamStatus;
  const beyond = uncoveredUpstream.length > 0 ? ` — not marked complete: the ordering app holds ${uncoveredUpstream.join(', ')} beyond what shipped here${heldBack.length > 0 ? ` (left undated: ${heldBack.join('; ')})` : ''}; pull the campaign first` : '';
  if (intended === 0 && !statusChanges && (noteAlready || dateLines.length === 0 && !complete)) {
    return { ok: dateLines.length > 0 || complete, skipped: !(dateLines.length > 0 || complete), statusSet, message: `the ordering app already shows it (${upstreamStatus}) — nothing to write${beyond}` };
  }
  const fields: Record<string, unknown> = { items: mergedItems, notes: mergedNotes };
  if (statusSet) fields.status = statusSet;

  // local trail BEFORE the upstream mutation — refusing to write it
  // aborts the write-back entirely
  try {
    await d.appendNote({
      order_id: d.orderId,
      note: `[${today}] ${d.actor} ${dateLines.length > 0 ? `wrote ship dates to the ordering app: ${labels}` : 'confirmed the order complete in the ordering app (every line shipped here)'}; upstream status ${statusSet ? `-> '${statusSet}'` : `unchanged ('${upstreamStatus}')`}.${heldBack.length > 0 ? ` Left undated (ordering-app quantity beyond what shipped here): ${heldBack.join('; ')}.` : ''}`,
      detail: JSON.stringify({ lines: dateLines, held_back: heldBack, fully_shipped: d.fullyShipped, complete }),
      actor: d.actor,
    });
  } catch {
    return { ok: false, message: 'write-back NOT sent — the local audit note could not be written, and an upstream write without a local trail is not allowed' };
  }

  // The ordering app offers no conditional update: a PUT replaces items,
  // notes and status wholesale. So the order is read AGAIN immediately
  // before the write, with nothing awaited in between, and the write is
  // refused if anything the merge was built from moved since the planning
  // read (the admin editing a quantity, adding a note, cancelling) — the
  // next run re-plans from the new state. What remains is the one network
  // hop between this read and the PUT, the same residual the shipment
  // push has always carried; the verifying re-read after the PUT cannot
  // see into it, which is why the window is kept this small.
  let latest: B44Order;
  try {
    latest = await getB44Order(d.cfg, d.externalId);
  } catch (e: unknown) {
    return { ok: false, message: `write-back aborted before the write — could not re-read the ordering-app order (${e instanceof Error ? e.message : 'read failed'}); the next run retries` };
  }
  const moved = String(latest.updated_date ?? '') !== String(upstream.updated_date ?? '')
    || String(latest.status ?? '').trim() !== upstreamStatus
    || String(latest.notes ?? '') !== upstreamNotes
    || JSON.stringify(Array.isArray(latest.items) ? latest.items : []) !== JSON.stringify(upstreamItems);
  if (moved) {
    return { ok: false, skipped: true, message: `write-back held — the ordering app's order changed while it was being prepared (now "${String(latest.status ?? '')}"); nothing written, the next run re-plans from the new state` };
  }

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
    const noteOk = String(after.notes ?? '').includes(noteLine);
    const afterStatus = String(after.status ?? '').trim();
    const statusOk = statusSet ? afterStatus === statusSet : afterStatus === upstreamStatus;
    if (undated === 0 && noteOk && statusOk) {
      return { ok: true, statusSet, message: `ordering app updated: ${intended} item${intended === 1 ? '' : 's'} dated${labels ? ` (${labels})` : ''}${statusChanges ? `, status -> '${statusSet}'` : delivered ? ' (delivered there, kept)' : ''}${beyond}` };
    }
    const what = [undated > 0 ? `${undated} item(s) still undated` : null, noteOk ? null : 'note missing', statusOk ? null : `status is '${afterStatus}'`].filter(Boolean).join(', ');
    return { ok: false, message: `write-back partial — the ordering app shows ${what}${putError ? ` (transport: ${putError})` : ''}; the next run retries` };
  } catch {
    return { ok: false, message: `write-back outcome unknown — the update ${putError ? `threw (${putError})` : 'was sent'} and the verifying re-read failed; the next run retries (idempotent)` };
  }
}

// ---------------------------------------------------------------------------

export type ResetVoidedArgs = {
  cfg: B44Config;
  externalId: string;
  orderId: number;
  shipmentId: number;
  carrier: string;
  tracking: string;
  /** what the box recorded — cancelled_items for a cancelled box, items for a refund-voided one */
  boxLines: { sku: string; qty: string; productExternalId: string | null }[];
  /** why it did not ship, for the ordering app's note (the cancel reason, or "label refunded") */
  why: string;
  /** the status to restore when NOTHING else on the order has shipped — the operator's pick */
  restoreStatus: string;
  /** FRESH getPackableItems rows, read by the caller after the cancel/void */
  packable: PushPackableLine[];
  userName: string;
  appendNote: (params: Record<string, unknown>) => Promise<unknown>;
  /** markShipmentUpstreamReset: stamps upstream_reset_at; refuses a live box or one already stamped */
  markReset: (params: Record<string, unknown>) => Promise<unknown>;
};

/**
 * Take back what a push told the ordering app about a box that did NOT
 * ship — cancelled here (recorded by mistake) or voided by a label refund.
 * Nothing else in this app moves the ordering app backward, by design;
 * this is the one reverse, scoped to that one box:
 *  - items[].shipped_date is removed from the items of this box's products
 *    whose line is no longer covered here (what still shipped covers the
 *    ordering app's whole quantity, a date stays) — and only a date this
 *    app wrote (ISO); a date the other admin typed by hand is hers and is
 *    left, named in the outcome.
 *  - the box's own tracking line in the notes is marked "[CANCELLED]" and
 *    one "Cancelled per Ops app — box #<id> …" line is appended (the
 *    idempotency marker).
 *  - status is moved ONLY off 'shipped'/'partially_shipped', and only when
 *    the box's push is evidently what set it (its tracking line or its
 *    dates are there): to 'partially_shipped' when anything else on the
 *    order still shipped, otherwise to the operator's restoreStatus. An
 *    order still complete here keeps 'shipped' (a duplicate box); a
 *    remaining hand-typed date leaves the status to the operator;
 *    'delivered' and terminal states refuse the whole reset.
 * Same discipline as the pushes: local trail line first, a planning read,
 * a re-read right before the PUT that refuses if anything moved, then a
 * verifying re-read; only a verified (or a nothing-to-do) outcome stamps
 * upstream_reset_at. A second run finds its own marker and changes
 * nothing.
 */
export async function resetVoidedShipmentUpstream(d: ResetVoidedArgs): Promise<PushOutcome> {
  const stamp = async (detail: Record<string, unknown>) => {
    try {
      const res = await d.markReset({ shipment_id: d.shipmentId, actor: d.userName, reset: JSON.stringify(detail) }) as unknown[] | null;
      return Array.isArray(res) ? res.length > 0 : !!res;
    } catch { return false; }
  };
  if (!d.externalId) {
    // added locally — the ordering app never held this order
    await stamp({ outcome: 'no ordering-app order' });
    return { ok: true, message: 'Nothing to reset — this order has no ordering-app id.' };
  }
  if (!d.cfg.token) return { ok: false, message: 'Ordering app NOT reset — no Base44 token in Settings. The cancel is saved; use "Reset ordering app" once the token is set.' };
  const restore = d.restoreStatus.trim();
  if (!restore || /ship|deliver|cancel|refund|reject|void|denied/i.test(restore)) {
    return { ok: false, message: 'Ordering app NOT reset — pick the status the order goes back to (e.g. verified).' };
  }
  const today = new Date().toLocaleDateString('en-CA');
  const carrierU = d.carrier.toUpperCase();
  const trackPrefix = d.tracking ? `Shipped ${carrierU} ${d.tracking}` : '';
  const marker = `Cancelled per Ops app — box #${d.shipmentId} ${carrierU}${d.tracking ? ` ${d.tracking}` : ''}`;
  const cancelLine = `${marker} did not ship (${d.why.replace(/\s+/g, ' ').trim()}) (${today})`;

  let upstream: B44Order;
  try {
    upstream = await getB44Order(d.cfg, d.externalId);
  } catch (e: unknown) {
    return { ok: false, message: `Ordering app NOT reset — could not read the order (${e instanceof Error ? e.message : 'read failed'}). The cancel is saved; use "Reset ordering app" to retry.` };
  }
  const status = String(upstream.status ?? '').trim();
  if (/cancel|refund|reject|void|denied/i.test(status)) {
    return { ok: false, message: `Ordering app NOT reset — it shows the order "${status}"; nothing written. Check the order there.` };
  }
  if (/delivered/i.test(status)) {
    return { ok: false, message: 'Ordering app NOT reset — it shows the order "delivered", a later fact than this box. If nothing went out, correct it there by hand.' };
  }

  // what is covered HERE now, per ordering-app product (the voided box no
  // longer counts), against the ordering app's quantity for it
  const coverage = new Map<string, number>();
  for (const l of d.packable) {
    if (l.digital || !l.product_external_id) continue;
    const eff = Number(l.effective_qty);
    const c = l.direct_ship ? (l.direct_fulfilled_at ? eff : 0) : Math.min(Number(l.shipped_qty), eff);
    coverage.set(l.product_external_id, (coverage.get(l.product_external_id) ?? 0) + c);
  }
  const upstreamItems = Array.isArray(upstream.items) ? upstream.items : [];
  const upQty = new Map<string, number>();
  for (const it of upstreamItems) {
    const pid = String(it.product_id ?? '');
    const q = Number(it.quantity ?? 0);
    if (pid && q > 0) upQty.set(pid, (upQty.get(pid) ?? 0) + q);
  }
  const covered = (pid: string) => (upQty.get(pid) ?? 0) > 0 && (coverage.get(pid) ?? 0) + 1e-9 >= (upQty.get(pid) ?? 0);
  const boxPids = new Set(d.boxLines.map(l => l.productExternalId).filter((p): p is string => !!p));
  const cleared: string[] = [];
  const clearedPids = new Set<string>();
  const handLeft: string[] = [];
  const mergedItems: B44OrderItem[] = upstreamItems.map(it => {
    const pid = String(it.product_id ?? '');
    if (!pid || !boxPids.has(pid) || !it.shipped_date || covered(pid)) return it;
    const name = String(it.product_name ?? pid);
    if (isHandSetDate(it.shipped_date)) { handLeft.push(`${name} (${String(it.shipped_date)})`); return it; }
    // an item that never shipped carries no shipped_date at all
    const rest: B44OrderItem = { ...it };
    delete rest.shipped_date;
    cleared.push(name);
    clearedPids.add(pid);
    return rest;
  });

  const upstreamNotes = String(upstream.notes ?? '');
  let struck = 0;
  const noteLines = upstreamNotes === '' ? [] : upstreamNotes.split('\n').map(line => {
    if (trackPrefix && line.startsWith(trackPrefix)) { struck++; return `[CANCELLED] ${line}`; }
    return line;
  });
  const markerThere = upstreamNotes.includes(marker);

  // the order's state here without the box (fully-shipped exactly as the push computes it)
  const packableLines = d.packable.filter(l => !l.direct_ship && !l.digital && Number(l.effective_qty) > 0);
  const directLines = d.packable.filter(l => l.direct_ship && !l.digital);
  const stillComplete = d.packable.length > 0
    && packableLines.every(l => Number(l.shipped_qty) >= Number(l.effective_qty))
    && directLines.every(l => l.direct_fulfilled_at != null);
  const stillShippedHere = d.packable.some(l => !l.digital && (l.direct_ship ? !!l.direct_fulfilled_at : Number(l.shipped_qty) > 0));
  const datedAfter = mergedItems.some(it => !!it.shipped_date);
  // the status is this box's to take back only when its push evidently set it
  const ours = struck > 0 || cleared.length > 0;
  let statusSet: string | null = null;
  let statusWhy = '';
  if (/^(shipped|partially_shipped)$/i.test(status)) {
    if (!ours) statusWhy = ' — not set by this box';
    else if (stillComplete) statusWhy = ' — the rest of the order still covers it';
    else if (handLeft.length > 0) statusWhy = ' — a hand-typed ship date remains';
    else statusSet = stillShippedHere || datedAfter ? 'partially_shipped' : restore;
    if (statusSet === status) statusSet = null;
  }
  const handNote = handLeft.length > 0
    ? ` Left the hand-typed ship date on ${handLeft.join(', ')} — if that did not ship either, clear it in the ordering app, or the auto-adopt pass will record it here again.`
    : '';
  const detail = { prior_status: status, status_set: statusSet, dates_cleared: cleared, hand_dates_left: handLeft, notes_struck: struck };

  if (cleared.length === 0 && !statusSet && struck === 0) {
    // nothing of this box is there (never pushed, or an earlier reset
    // landed and only its stamp was lost)
    const stamped = await stamp({ ...detail, outcome: markerThere ? 'already reset' : 'nothing there' });
    return {
      ok: stamped,
      message: stamped
        ? `Ordering app already clear of this box (status "${status}")${markerThere ? '' : ' — it was never told about it'}.${handNote}`
        : 'The ordering app is clear of this box, but the local record did not save — use "Reset ordering app" again.',
    };
  }
  if (!markerThere) noteLines.push(cancelLine);
  const mergedNotes = noteLines.join('\n');
  const fields: Record<string, unknown> = { items: mergedItems, notes: mergedNotes };
  if (statusSet) fields.status = statusSet;
  const what = `${cleared.length > 0 ? `ship date cleared on ${cleared.join(', ')}` : 'no ship dates to clear'}; status ${statusSet ? `'${status}' -> '${statusSet}'` : `left '${status}'${statusWhy}`}; tracking note marked cancelled`;

  // local trail BEFORE the upstream mutation — refusing to write it aborts
  try {
    await d.appendNote({
      order_id: d.orderId,
      note: `[${today}] ${d.userName} reset the ordering app for box #${d.shipmentId} ${carrierU} ${d.tracking} (did not ship: ${d.why}): ${what}.`,
      detail: JSON.stringify({ shipment_id: d.shipmentId, ...detail }),
      actor: d.userName,
    });
  } catch {
    return { ok: false, message: 'Ordering app NOT reset — the local audit note could not be written, and an upstream write without a local trail is not allowed. Retry.' };
  }

  // a PUT replaces items, notes and status wholesale: re-read with nothing
  // awaited in between and refuse if anything the merge was built from moved
  let latest: B44Order;
  try {
    latest = await getB44Order(d.cfg, d.externalId);
  } catch (e: unknown) {
    return { ok: false, message: `Ordering app NOT reset — could not re-read the order right before writing (${e instanceof Error ? e.message : 'read failed'}). Retry "Reset ordering app".` };
  }
  const moved = String(latest.updated_date ?? '') !== String(upstream.updated_date ?? '')
    || String(latest.status ?? '').trim() !== status
    || String(latest.notes ?? '') !== upstreamNotes
    || JSON.stringify(Array.isArray(latest.items) ? latest.items : []) !== JSON.stringify(upstreamItems);
  if (moved) {
    return { ok: false, message: `Ordering app NOT reset — the order changed there while this was being prepared (now "${String(latest.status ?? '')}"); nothing written. Retry "Reset ordering app" to plan from the new state.` };
  }

  let putError: string | null = null;
  try {
    await updateB44Order(d.cfg, d.externalId, fields);
  } catch (e: unknown) {
    putError = e instanceof Error ? e.message : 'update failed';
  }

  try {
    const after = await getB44Order(d.cfg, d.externalId);
    const afterItems = Array.isArray(after.items) ? after.items : [];
    const stillDated = afterItems.filter(it => clearedPids.has(String(it.product_id ?? '')) && !!it.shipped_date).length;
    const afterNotes = String(after.notes ?? '');
    const noteOk = afterNotes.includes(marker) && !(trackPrefix && afterNotes.split('\n').some(l => l.startsWith(trackPrefix)));
    const afterStatus = String(after.status ?? '').trim();
    const statusOk = statusSet ? afterStatus === statusSet : afterStatus === status;
    if (stillDated === 0 && noteOk && statusOk) {
      const stamped = await stamp(detail);
      if (!stamped) return { ok: false, message: 'Ordering app reset (verified), but the local record did not save — use "Reset ordering app" again; it changes nothing twice.' };
      return { ok: true, message: `Ordering app reset: ${what}.${handNote}` };
    }
    const miss = [stillDated > 0 ? `${stillDated} ship date(s) still set` : null, noteOk ? null : 'note not updated', statusOk ? null : `status is '${afterStatus}'`].filter(Boolean).join(', ');
    return { ok: false, message: `Ordering app reset PARTIAL — it shows ${miss}${putError ? ` (transport: ${putError})` : ''}. Use "Reset ordering app" to retry.` };
  } catch {
    return { ok: false, message: `Ordering app reset outcome UNKNOWN — the update ${putError ? `threw (${putError})` : 'was sent'} and the verifying re-read failed. Use "Reset ordering app" to retry; it changes nothing twice.` };
  }
}
