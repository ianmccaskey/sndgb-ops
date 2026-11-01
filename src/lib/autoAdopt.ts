import type { B44Config, B44Order } from '@/lib/base44';
import type { PushDatesOutcome, PushDatesArgs, UpstreamLease } from '@/lib/pushShipment';

/*
 * The deterministic auto-adopt pass (2026-11-01). The ordering app (base44)
 * and this app each keep their own "shipped" marks. A box shipped HERE is
 * written back to the ordering app by pushShipmentUpstream; a mark made
 * BY HAND in the ordering app reached this app only when an operator ran
 * "Check ordering app" and clicked Adopt. This pass does that pull-down
 * on its own, after every ordering-app import and when Fulfillment opens,
 * acting only where the evidence is unambiguous:
 *
 *  1. ADOPT: an item the ordering app marks shipped BY HAND (its
 *     shipped_date written as display text, "Oct 31, 2026" — this app
 *     writes ISO "2026-10-31", so the format names the writer) whose local
 *     line has NOTHING recorded (no box, no draft, no adopted row) is
 *     recorded through adopt_upstream_shipment_untouched: the Adopt
 *     button's write (a finalized shipment at the ordering app's date,
 *     carrier 'upstream', no tracking) behind a database check, under the
 *     order lock, that the line still has zero attribution — so a second
 *     run, a concurrent run, or a draft opened meanwhile can never record
 *     the same mark twice. One date, one quantity, re-read fresh right
 *     before writing.
 *  2. VENDOR SHIPPED: a hand mark covering a vendor-direct line's whole
 *     quantity stamps direct_fulfilled_at through markOrderDirectFulfilled
 *     (item mode), the Direct ship tab's own write — after the same
 *     validation and fresh re-read as an adoption.
 *  3. WRITE-BACK: a line fully shipped HERE (a finalized box, or a
 *     vendor-direct line marked vendor shipped) that the ordering app
 *     still shows undated gets its shipped_date and a note there, through
 *     the same read-merge-write-verify discipline the shipment push uses —
 *     so the other admin never sees as unshipped what already left.
 *
 * NEVER: record over a line that already has a box, a draft or an adopted
 * row here (a box within a day of the hand mark is the same shipment
 * written down twice; anything else is a possible double shipment, listed
 * under "needs you" with both records); act on an order-level "shipped"
 * status with no per-item dates (the Adopt button asks for an explicit
 * confirmation there, so the unattended pass asks the operator); act on an
 * item carrying two different ship dates, an unparseable one, or a
 * quantity short of a vendor-direct line; link products. Every write runs
 * under the actor the caller passes ("<operator> (auto-adopt)"), and a run
 * that changed anything writes one auto_adopt_run summary row.
 */

export type AdoptCandidateLine = {
  order_id: number; order_number: string; external_id: string;
  order_item_id: number; product_external_id: string | null; sku_code: string;
  digital: boolean; direct_ship: boolean; direct_fulfilled_at: string | null;
  direct_vendor_carrier: string | null; direct_vendor_tracking: string | null;
  effective_qty: string; attributed_qty: string; shipped_qty: string; adopted_qty: string; local_box_qty: string;
  last_shipped_on: string | null; boxes: string | null;
  /** an audited upstream completion (status 'shipped') already exists for the order */
  completion_logged: boolean;
};

export type AutoAdoptItemKind = 'adopted' | 'vendor_marked' | 'pushed' | 'needs_you' | 'skipped' | 'error';

export type AutoAdoptItem = {
  kind: AutoAdoptItemKind;
  orderNumber: string;
  orderId: number;
  message: string;
};

export type AutoAdoptSummary = {
  groupBuyId: number;
  trigger: string;
  startedAt: string;
  finishedAt: string;
  /** ordering-app orders read */
  upstreamSeen: number;
  /** item ship dates set by hand in the ordering app */
  handMarks: number;
  adopted: number;
  vendorMarked: number;
  pushed: number;
  needsYou: number;
  skipped: number;
  errors: number;
  items: AutoAdoptItem[];
};

export type AutoAdoptDeps = {
  cfg: B44Config;
  gbExternalId: string;
  /** audit actor for every write, e.g. "Ian (auto-adopt)" */
  actor: string;
  /** the order's ordering-app write lease (upstreamLease) — claimed before a write-back reads the local lines */
  lease: (orderId: number) => UpstreamLease;
  listCandidates: (groupBuyId: number) => Promise<unknown>;
  /** getAdoptCandidateOrder: ONE order's lines in the same shape, read fresh around every write-back */
  getOrderLines: (orderId: number) => Promise<unknown>;
  listUpstream: (cfg: B44Config, gbExternalId: string) => Promise<B44Order[]>;
  getUpstream: (cfg: B44Config, orderId: string) => Promise<B44Order>;
  /** adopt_upstream_shipment_untouched: refuses (zero rows) unless every line still has zero attribution */
  adopt: (p: { order_id: number; group_buy_id: number; items: string; shipped_date: string; note: string; actor: string }) => Promise<unknown>;
  /** markOrderDirectFulfilled, item mode; expected_qty makes the stamp refuse a line whose quantity changed since it was read */
  markDirect: (p: { order_id: number; item_id: string; expected_ids: string; expected_qty: string; fulfilled: boolean; vendor_carrier: string; vendor_tracking: string; actor: string }) => Promise<unknown>;
  pushDates: (p: PushDatesArgs) => Promise<PushDatesOutcome>;
  appendNote: (p: { order_id: number; note: string; detail: string; actor: string }) => Promise<unknown>;
  /** logUpstreamCompletion: the durable completion evidence the digital-flip guard consumes (idempotent per order) */
  logCompletion: (p: { order_id: number; actor: string; pushed: string }) => Promise<unknown>;
  logRun: (p: { group_buy_id: number; actor: string; detail: string }) => Promise<unknown>;
};

/** Terminal ordering-app statuses — never adopt from, never write to. */
const TERMINAL = /cancel|refund|reject|void|denied/i;
const shippedLike = (s: string) => ['shipped', 'delivered'].includes(s.trim().toLowerCase());

/**
 * Who wrote an ordering-app item's shipped_date. This app's push writes
 * the operator's local calendar date in ISO form (pushShipment: en-CA);
 * the ordering app's own UI stores display text ("Oct 31, 2026"). A date
 * that is not ISO-prefixed is therefore a mark made over there by hand —
 * the only kind this app can be missing.
 */
export function isHandSetDate(v: unknown): boolean {
  const s = String(v ?? '').trim();
  return s !== '' && !/^\d{4}-\d{2}-\d{2}/.test(s);
}

/** YYYY-MM-DD (local calendar) for any date text the ordering app stores; '' when unparseable. */
export function isoDateOf(v: unknown): string {
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-CA') : '';
}

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res.filter(x => x != null && typeof x === 'object') as T[];
  if (res && typeof res === 'object' && Array.isArray((res as { data?: unknown }).data)) return rowsOf<T>((res as { data: unknown }).data);
  return [];
}

function wroteRows(res: unknown): boolean {
  return Array.isArray(res) ? res.length > 0 : !!res;
}

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** A hand mark and a box here no more than a day apart are one shipment recorded twice (the mark is a calendar date; the box a timestamp). */
const SAME_SHIPMENT_MS = 36 * 60 * 60 * 1000;

/** The finalized box dates in listAdoptCandidates' `boxes` text ("YYYY-MM-DD carrier tracking; …"). */
export function boxDatesOf(boxes: string | null | undefined): string[] {
  return String(boxes ?? '').split(';').map(s => s.trim().slice(0, 10)).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

type UpItem = { pid: string; name: string; qty: number; raw: unknown; hand: boolean; iso: string };

function upstreamItems(o: B44Order): UpItem[] {
  return (Array.isArray(o.items) ? o.items : [])
    .filter(it => it.product_id != null && String(it.product_id) !== '')
    .map(it => ({
      pid: String(it.product_id), name: String(it.product_name ?? it.product_id), qty: num(it.quantity),
      raw: it.shipped_date, hand: isHandSetDate(it.shipped_date), iso: isoDateOf(it.shipped_date),
    }));
}

type HandFacts = { dates: string[]; qty: number; unparseable: boolean };

/** The hand-set ship facts for one product on one ordering-app order: distinct dates and total quantity. */
function handFacts(items: UpItem[], pid: string): HandFacts {
  const hits = items.filter(it => it.pid === pid && it.hand);
  const dates = Array.from(new Set(hits.map(h => h.iso)));
  return { dates: dates.filter(Boolean), qty: hits.reduce((s, h) => s + (h.qty > 0 ? h.qty : 0), 0), unparseable: dates.includes('') };
}

/**
 * ONE usable hand mark for a product, or the reason there is none. Shared
 * by packed adoption and vendor-direct marking so both act on the same
 * evidence standard: exactly one parseable date and a positive quantity.
 */
function usableMark(facts: HandFacts, raw: unknown): { ok: true; date: string; qty: number } | { ok: false; reason: string } {
  if (facts.unparseable) return { ok: false, reason: `the ordering app's ship date "${String(raw)}" cannot be read as a date` };
  if (facts.dates.length !== 1) return { ok: false, reason: `the ordering app carries ${facts.dates.length} different ship dates for it (${facts.dates.join(', ')}) — ambiguous` };
  if (!(facts.qty > 0)) return { ok: false, reason: `the ordering app's shipped quantity is unusable` };
  return { ok: true, date: facts.dates[0], qty: facts.qty };
}

type WriteBackPlan = {
  toPush: PushDatesArgs['lines'];
  coverage: PushDatesArgs['coverage'];
  fullyShipped: boolean;
  completionLogged: boolean;
  /** "needs you" text when everything imported shipped but the ordering app holds more */
  upstreamAheadWarn: string | null;
  /** "needs you" texts for lines shipped here short of the ordering app's quantity */
  shortfalls: string[];
};

/**
 * What a write-back for one order would send, computed from the local
 * lines AS GIVEN: dates for lines fully shipped here that the ordering
 * app shows undated (only when the line covers the ordering app's whole
 * quantity for that product), what this app shipped per product, and
 * whether the order is complete here and upstream. Pure — called on the
 * run's opening read, again on a fresh read right before the write, and
 * once more after it; the plans must agree line for line or nothing is
 * written.
 */
function planWriteBack(loc: AdoptCandidateLine[], ups: UpItem[], status: string): WriteBackPlan {
  const upQty = new Map<string, number>();
  for (const it of ups) if (it.qty > 0) upQty.set(it.pid, (upQty.get(it.pid) ?? 0) + it.qty);
  const coverage: PushDatesArgs['coverage'] = {};
  for (const l of loc) {
    const pid = String(l.product_external_id ?? '');
    if (!pid) continue;
    const eff = num(l.effective_qty);
    const covered = l.direct_ship ? (l.direct_fulfilled_at ? eff : 0) : Math.min(num(l.shipped_qty), eff);
    const prev = coverage[pid];
    coverage[pid] = { covered: (prev?.covered ?? 0) + covered, digital: (prev?.digital ?? true) && l.digital };
  }
  const toPush: PushDatesArgs['lines'] = [];
  const uncovered: string[] = [];
  const shortfalls: string[] = [];
  for (const l of loc) {
    if (l.digital) continue;
    const eff = num(l.effective_qty);
    const covered = l.direct_ship ? !!l.direct_fulfilled_at : eff > 0 && num(l.shipped_qty) >= eff;
    if (!covered) { uncovered.push(l.sku_code); continue; }
    const pid = String(l.product_external_id ?? '');
    const up = ups.find(it => it.pid === pid);
    if (!pid || !up || up.iso !== '' || String(up.raw ?? '') !== '') continue;
    if (eff + 1e-9 < (upQty.get(pid) ?? 0)) {
      shortfalls.push(`${l.sku_code}: ${eff} shipped here, but the ordering app now holds ${upQty.get(pid)} — a quantity added there since the last pull; pull the campaign, then its ship date is written`);
      continue;
    }
    if (l.direct_ship) {
      const date = isoDateOf(l.direct_fulfilled_at);
      if (!date) continue;
      const label = `Vendor shipped${l.direct_vendor_carrier ? ` ${l.direct_vendor_carrier.toUpperCase()}` : ''}${l.direct_vendor_tracking ? ` ${l.direct_vendor_tracking}` : ''} — ${l.sku_code} x ${eff}`;
      toPush.push({ productExternalId: pid, date, label });
    } else {
      const date = l.last_shipped_on ? isoDateOf(l.last_shipped_on) : '';
      if (!date) continue;
      toPush.push({ productExternalId: pid, date, label: `Shipped here — ${l.sku_code} x ${eff} (${l.boxes ?? 'box'})` });
    }
  }
  const upstreamAhead = [...upQty.entries()].filter(([pid, q]) => !coverage[pid] || (!coverage[pid].digital && coverage[pid].covered + 1e-9 < q))
    .map(([pid, q]) => `${ups.find(it => it.pid === pid)?.name ?? pid} x${q}`);
  const localCovered = uncovered.length === 0 && loc.some(l => !l.digital);
  const fullyShipped = localCovered && upstreamAhead.length === 0;
  const upstreamAheadWarn = localCovered && upstreamAhead.length > 0 && !shippedLike(status)
    ? `everything imported here has shipped, but the ordering app holds ${upstreamAhead.join(', ')} beyond it (a line or quantity added there since the last pull) — pull the campaign, then this order completes`
    : null;
  return { toPush, coverage, fullyShipped, completionLogged: loc.some(l => l.completion_logged === true), upstreamAheadWarn, shortfalls };
}

/** The part of a plan that reaches the ordering app, as one comparable string. */
function planKey(p: WriteBackPlan): string {
  return JSON.stringify([p.toPush.map(l => [l.productExternalId, l.date]).sort(), p.fullyShipped, Object.entries(p.coverage).sort()]);
}

export async function runAutoAdopt(groupBuyId: number, deps: AutoAdoptDeps): Promise<AutoAdoptSummary> {
  const startedAt = new Date().toISOString();
  const items: AutoAdoptItem[] = [];
  const counts = { adopted: 0, vendorMarked: 0, pushed: 0, needsYou: 0, skipped: 0, errors: 0 };
  const push = (it: AutoAdoptItem) => {
    items.push(it);
    if (it.kind === 'adopted') counts.adopted++;
    else if (it.kind === 'vendor_marked') counts.vendorMarked++;
    else if (it.kind === 'pushed') counts.pushed++;
    else if (it.kind === 'needs_you') counts.needsYou++;
    else if (it.kind === 'skipped') counts.skipped++;
    else counts.errors++;
  };

  const lines = rowsOf<AdoptCandidateLine>(await deps.listCandidates(groupBuyId));
  const byExt = new Map<string, AdoptCandidateLine[]>();
  for (const l of lines) {
    const k = String(l.external_id);
    byExt.set(k, [...(byExt.get(k) ?? []), l]);
  }

  const upstream = await deps.listUpstream(deps.cfg, deps.gbExternalId);
  let handMarks = 0;

  for (const o of upstream) {
    const status = String(o.status ?? '').trim();
    if (TERMINAL.test(status)) continue;
    const ups = upstreamItems(o);
    const hand = ups.filter(it => it.hand);
    handMarks += hand.length;
    const loc = byExt.get(String(o.id));
    if (!loc || loc.length === 0) {
      if (hand.length > 0 || shippedLike(status)) {
        push({ kind: 'skipped', orderNumber: String(o.order_number ?? o.id), orderId: 0, message: `marked shipped in the ordering app but not imported here — nothing to record until a pull brings it in` });
      }
      continue;
    }
    const orderId = Number(loc[0].order_id);
    const orderNumber = String(loc[0].order_number);
    const linesFor = (pid: string) => loc.filter(l => String(l.product_external_id ?? '') === pid);

    // ---- 1 + 2: hand marks → PLAN adoptions and vendor-direct marks -----
    // adoptions grouped by ship date: one shipment row per date, each
    // carrying its true shipped_at (as the Adopt button does)
    type Planned = { order_item_id: number; pid: string; qty: string; sku: string; date: string; clamped: boolean };
    const planned = new Map<string, Planned[]>();
    const plannedDirect: Planned[] = [];
    const seenPid = new Set<string>();
    for (const it of ups) {
      if (!it.hand || seenPid.has(it.pid)) continue;
      seenPid.add(it.pid);
      const ls = linesFor(it.pid);
      if (ls.length === 0) {
        push({ kind: 'needs_you', orderNumber, orderId, message: `the ordering app marks "${it.name}" shipped (${it.iso || String(it.raw)}) but no line here is linked to that ordering-app product — link it under Products › Ordering app, then run again` });
        continue;
      }
      const facts = handFacts(ups, it.pid);
      for (const l of ls) {
        if (l.digital) continue;
        const eff = num(l.effective_qty);
        if (l.direct_ship) {
          if (l.direct_fulfilled_at) continue;
          const mark = usableMark(facts, it.raw);
          if (!mark.ok) { push({ kind: 'needs_you', orderNumber, orderId, message: `${l.sku_code} (vendor-direct): ${mark.reason} — mark it by hand on the Direct ship tab if the vendor shipped it` }); continue; }
          if (mark.qty + 1e-9 < eff) { push({ kind: 'needs_you', orderNumber, orderId, message: `${l.sku_code} (vendor-direct): the ordering app marks ${mark.qty} of ${eff} shipped — a vendor-direct line is marked sent whole or not at all, so decide by hand on the Direct ship tab` }); continue; }
          plannedDirect.push({ order_item_id: Number(l.order_item_id), pid: it.pid, qty: eff.toFixed(2), sku: l.sku_code, date: mark.date, clamped: false });
          continue;
        }
        const attributed = num(l.attributed_qty), shipped = num(l.shipped_qty), adopted = num(l.adopted_qty), localBox = num(l.local_box_qty);
        if (localBox > 0) {
          // a box here within a day of the hand mark is the SAME shipment
          // written down in both places (the other admin marks it there,
          // the box is recorded here) — consistent, nothing to flag. A box
          // further away is a second record of the same line: possibly a
          // second parcel, so it is listed with both records every run
          // until the operator settles it.
          if (facts.dates.some(d => boxDatesOf(l.boxes).some(b => Math.abs(Date.parse(d) - Date.parse(b)) <= SAME_SHIPMENT_MS))) continue;
          push({ kind: 'needs_you', orderNumber, orderId, message: `${l.sku_code} x${eff} is marked shipped BY HAND in the ordering app (${facts.dates.join(' / ') || String(it.raw)}) and ALSO sits in a box shipped from here (${l.boxes ?? ''}) — a possible double shipment; nothing recorded, check with the other admin` });
          continue;
        }
        if (adopted > 0) {
          // already pulled down (this pass or the Adopt button). The mark
          // is never read twice: a larger quantity there now is a change
          // the operator must judge, not a second adoption.
          if (facts.qty > adopted + 1e-9 && eff - attributed > 0) {
            push({ kind: 'needs_you', orderNumber, orderId, message: `${l.sku_code}: ${adopted} already recorded from the ordering app, which now marks ${facts.qty} shipped — adopt the difference by hand if a further parcel went out` });
          }
          continue;
        }
        if (attributed > 0) {
          // a draft reserves it (attributed > shipped with no finalized
          // box): the pass never records under a draft
          push({ kind: 'needs_you', orderNumber, orderId, message: `${l.sku_code}: the ordering app marks it shipped by hand, but a draft box here already reserves it — finalize or delete the draft, then run again` });
          continue;
        }
        if (!(eff > 0)) continue;
        const mark = usableMark(facts, it.raw);
        if (!mark.ok) { push({ kind: 'needs_you', orderNumber, orderId, message: `${l.sku_code}: ${mark.reason} — adopt by hand (Fulfillment › Check ordering app)` }); continue; }
        const q = Math.min(eff, mark.qty);
        planned.set(mark.date, [...(planned.get(mark.date) ?? []), { order_item_id: Number(l.order_item_id), pid: it.pid, qty: q.toFixed(2), sku: l.sku_code, date: mark.date, clamped: q < eff }]);
      }
    }

    // ---- confirm-time freshness, then the writes ------------------------
    if (planned.size > 0 || plannedDirect.length > 0) {
      // as the Adopt button does: the other admin may have corrected the
      // ordering app since the list was pulled — every planned line must
      // still carry the very mark it was planned from
      let fresh: B44Order | null = null;
      try { fresh = await deps.getUpstream(deps.cfg, String(o.id)); } catch (e: unknown) {
        push({ kind: 'error', orderNumber, orderId, message: `could not re-read the ordering-app order before recording — ${e instanceof Error ? e.message : String(e)}; nothing recorded this run` });
      }
      if (fresh) {
        const freshUps = upstreamItems(fresh);
        const freshStatus = String(fresh.status ?? '').trim();
        const stillHolds = (p: Planned) => {
          const f = handFacts(freshUps, p.pid);
          return f.dates.length === 1 && f.dates[0] === p.date && !f.unparseable && f.qty + 1e-9 >= Number(p.qty);
        };
        if (TERMINAL.test(freshStatus)) {
          push({ kind: 'skipped', orderNumber, orderId, message: `the ordering app now shows the order "${freshStatus}" — nothing recorded` });
        } else {
          for (const p of plannedDirect) {
            if (!stillHolds(p)) { push({ kind: 'skipped', orderNumber, orderId, message: `${p.sku}: the ordering app's mark changed between the pull and the write — not marked; the next run re-reads it` }); continue; }
            try {
              // the stamp names the quantity the mark covers: a line whose
              // quantity changed since the read (an import, an edit)
              // refuses in the database rather than being marked whole
              const wrote = wroteRows(await deps.markDirect({
                order_id: orderId, item_id: String(p.order_item_id), expected_ids: '', expected_qty: p.qty,
                fulfilled: true, vendor_carrier: '', vendor_tracking: '', actor: deps.actor,
              }));
              if (wrote) push({ kind: 'vendor_marked', orderNumber, orderId, message: `${p.sku} x${Number(p.qty)} marked vendor shipped — the ordering app says it shipped ${p.date}` });
              else push({ kind: 'skipped', orderNumber, orderId, message: `${p.sku}: the vendor-direct line changed (quantity or state) before it could be marked — nothing written; the next run re-reads it` });
            } catch (e: unknown) {
              push({ kind: 'error', orderNumber, orderId, message: `${p.sku}: vendor-shipped mark failed — ${e instanceof Error ? e.message : String(e)}` });
            }
          }
          for (const [date, ls] of planned) {
            const held = ls.filter(stillHolds);
            const changed = ls.filter(p => !held.includes(p));
            if (changed.length > 0) push({ kind: 'skipped', orderNumber, orderId, message: `${changed.map(p => p.sku).join(', ')}: the ordering app's mark changed between the pull and the write — not recorded; the next run re-reads it` });
            if (held.length === 0) continue;
            const note = `Recorded from ordering app (status "${status}"; item shipped date ${date}) — no tracking; adopted automatically by the auto-adopt pass.`;
            try {
              const wrote = wroteRows(await deps.adopt({
                order_id: orderId, group_buy_id: groupBuyId,
                items: JSON.stringify(held.map(p => ({ order_item_id: p.order_item_id, qty: p.qty }))),
                shipped_date: date, note, actor: deps.actor,
              }));
              if (wrote) push({ kind: 'adopted', orderNumber, orderId, message: `${held.map(p => `${p.sku} x${Number(p.qty)}${p.clamped ? ' (clamped to what the ordering app shipped)' : ''}`).join(', ')} recorded as shipped ${date} from the ordering app (no tracking)` });
              else push({ kind: 'skipped', orderNumber, orderId, message: `${held.map(p => p.sku).join(', ')}: the database refused the record (something was recorded on the line meanwhile, the order changed, or the date is out of range) — nothing written` });
            } catch (e: unknown) {
              push({ kind: 'error', orderNumber, orderId, message: `${held.map(p => p.sku).join(', ')}: adoption failed — ${e instanceof Error ? e.message : String(e)}` });
            }
          }
        }
      }
    }

    // ---- order-level status with no item dates: too weak to act on ----
    if (shippedLike(status) && !ups.some(it => it.iso !== '')) {
      const openPacked = loc.filter(l => !l.digital && !l.direct_ship && num(l.effective_qty) - num(l.attributed_qty) > 0);
      const openDirect = loc.filter(l => !l.digital && l.direct_ship && !l.direct_fulfilled_at);
      const drafted = loc.filter(l => !l.digital && !l.direct_ship && num(l.attributed_qty) > num(l.shipped_qty));
      const boxed = loc.filter(l => num(l.local_box_qty) > 0);
      if (openPacked.length > 0 || openDirect.length > 0) {
        push({ kind: 'needs_you', orderNumber, orderId, message: `the ordering app's status is "${status}" with no per-item ship dates${boxed.length > 0 ? ' while part of it shipped from here' : ''} — too weak to record unattended; confirm by hand under Fulfillment › Check ordering app (Adopt for ${openPacked.map(l => l.sku_code).join(', ') || 'none'}; Vendor shipped for ${openDirect.map(l => l.sku_code).join(', ') || 'none'})` });
      } else if (drafted.length > 0) {
        push({ kind: 'needs_you', orderNumber, orderId, message: `the ordering app's status is "${status}" while a draft box here still reserves ${drafted.map(l => l.sku_code).join(', ')} — finalize the draft if that box went out, or delete it and adopt from the ordering app` });
      }
    }

    // ---- 3: write-back — shipped here, undated there --------------------
    // planned from the local lines as read NOW (re-read right before the
    // write and again after it: an undo of a vendor-shipped mark, a
    // quantity edit or a voided box in between must hold the write back
    // or be reported — the run's opening read is not evidence enough)
    const planned0 = planWriteBack(loc, ups, status);
    if (planned0.upstreamAheadWarn) push({ kind: 'needs_you', orderNumber, orderId, message: planned0.upstreamAheadWarn });
    for (const m of planned0.shortfalls) push({ kind: 'needs_you', orderNumber, orderId, message: m });
    const logCompletion = async (reason: string, labels: string[]) => {
      try {
        const wrote = wroteRows(await deps.logCompletion({
          order_id: orderId, actor: deps.actor,
          pushed: JSON.stringify({ reason, lines: labels }),
        }));
        if (wrote) push({ kind: 'pushed', orderNumber, orderId, message: `completion recorded (the ordering app shows the order shipped and every line is covered here)` });
      } catch (e: unknown) {
        push({ kind: 'error', orderNumber, orderId, message: `the completion record could not be written — ${e instanceof Error ? e.message : String(e)}; the next run retries` });
      }
    };
    // this pass wrote to the order upstream earlier (its note line is
    // there — written on every write-back, status-only ones included) and
    // the order is complete there: the durable evidence must exist too,
    // whatever failed after the PUT landed (verification, the audit row,
    // a closed tab)
    const completedByUs = /Shipped per Ops app/.test(String(o.notes ?? ''));
    // the write-back is owed for dated lines, AND — with nothing to date —
    // for an order covered here whose ordering-app status does not say so
    // yet (a line completed through a vendor mark, an earlier write
    // whose status step failed); the status is the retry marker, not the
    // item dates
    const statusOwed0 = planned0.fullyShipped && !shippedLike(status);
    // the order's upstream lease, held from BEFORE the fresh local read
    // through the write: no box of the order can be cancelled under it, so
    // the plan the write is built from never predates a cancel (1790103200)
    if (planned0.toPush.length > 0 || statusOwed0) {
      const lease = deps.lease(orderId);
      if (!(await lease.claim())) {
        push({ kind: 'skipped', orderNumber, orderId, message: `another write to this order's ordering-app record is in progress (or one is unresolved) — nothing written; the next run re-plans` });
      } else try {
        // fresh local read: the plan must still hold line for line
        let freshLoc: AdoptCandidateLine[] | null = null;
        try { freshLoc = rowsOf<AdoptCandidateLine>(await deps.getOrderLines(orderId)); } catch (e: unknown) {
          push({ kind: 'error', orderNumber, orderId, message: `could not re-read this order's local record before the write-back — ${e instanceof Error ? e.message : String(e)}; nothing written this run` });
        }
        if (freshLoc) {
          const planned1 = planWriteBack(freshLoc, ups, status);
          if (planKey(planned1) !== planKey(planned0) || freshLoc.length === 0) {
            push({ kind: 'skipped', orderNumber, orderId, message: `the local record changed during the run (a box, a vendor-shipped mark or a quantity) — nothing written to the ordering app; the next run re-reads it` });
          } else {
            try {
              const r = await deps.pushDates({
                cfg: deps.cfg, externalId: String(o.id), orderId, orderNumber,
                lines: planned1.toPush, fullyShipped: planned1.fullyShipped, coverage: planned1.coverage, actor: deps.actor, appendNote: deps.appendNote,
                lease,
              });
              if (r.ok) {
                push({ kind: 'pushed', orderNumber, orderId, message: r.message });
                // the write landed: did the local record change underneath it?
                // (the window between the re-read and the PUT) — the ordering
                // app now shows what the local record no longer supports, and
                // only the operator can settle which is right
                try {
                  const after = rowsOf<AdoptCandidateLine>(await deps.getOrderLines(orderId));
                  const planned2 = planWriteBack(after, ups, status);
                  if (planKey(planned2) !== planKey(planned1)) {
                    push({ kind: 'needs_you', orderNumber, orderId, message: `the local record changed WHILE the ordering app was being updated — the ordering app may now show shipped what this app no longer does; compare the two by hand and correct the ordering app if needed` });
                  } else if (r.statusSet === 'shipped' && !after.some(l => l.completion_logged === true)) {
                    await logCompletion('write-back set the ordering app to shipped', planned1.toPush.map(l => l.label));
                  }
                } catch (e: unknown) {
                  push({ kind: 'error', orderNumber, orderId, message: `could not re-read the local record after the write-back — ${e instanceof Error ? e.message : String(e)}; the next run checks it${r.statusSet === 'shipped' ? ' and records the completion' : ''}` });
                }
              } else push({ kind: r.skipped ? 'skipped' : 'error', orderNumber, orderId, message: r.message });
            } catch (e: unknown) {
              push({ kind: 'error', orderNumber, orderId, message: `write-back to the ordering app failed — ${e instanceof Error ? e.message : String(e)}` });
            }
          }
        }
      } finally {
        await lease.release();
      }
    } else if (planned0.fullyShipped && shippedLike(status) && completedByUs && !planned0.completionLogged) {
      // (fullyShipped already requires every upstream line covered) —
      // re-read first for the same reason
      try {
        const freshLoc = rowsOf<AdoptCandidateLine>(await deps.getOrderLines(orderId));
        const planned1 = planWriteBack(freshLoc, ups, status);
        if (planned1.fullyShipped && !planned1.completionLogged) await logCompletion('an earlier write-back completed the order; its evidence row was missing', []);
      } catch (e: unknown) {
        push({ kind: 'error', orderNumber, orderId, message: `could not re-read this order's local record — ${e instanceof Error ? e.message : String(e)}; the next run retries` });
      }
    }
  }

  const summary: AutoAdoptSummary = {
    groupBuyId, trigger: '', startedAt, finishedAt: new Date().toISOString(),
    upstreamSeen: upstream.length, handMarks, ...counts, items,
  };

  if (counts.adopted + counts.vendorMarked + counts.pushed > 0) {
    try {
      await deps.logRun({
        group_buy_id: groupBuyId, actor: deps.actor,
        detail: JSON.stringify({
          started_at: startedAt, finished_at: summary.finishedAt, upstream_seen: upstream.length, hand_marks: handMarks,
          adopted: counts.adopted, vendor_marked: counts.vendorMarked, pushed: counts.pushed,
          needs_you: counts.needsYou, skipped: counts.skipped, errors: counts.errors,
          changes: items.filter(i => i.kind === 'adopted' || i.kind === 'vendor_marked' || i.kind === 'pushed')
            .map(i => ({ kind: i.kind, order: i.orderNumber, what: i.message })),
        }),
      });
    } catch {
      push({ kind: 'error', orderNumber: '—', orderId: 0, message: 'the run summary audit row could not be written (every individual change is still audited)' });
      summary.errors++;
    }
  }
  return summary;
}
