import { B44_DEFAULT_APP_ID, getB44Order, updateB44Order } from '@/lib/base44';
import { UPSTREAM_METHOD } from '@/lib/chains';

/*
 * Rail correction — "customer selected ETH at checkout but paid on Solana",
 * after the payment itself was verified on the real network. ONE
 * implementation, used by the order sheet's button and by the
 * auto-reconcile pass, so the sequence and its trail are identical however
 * it is triggered:
 *
 *  1. LOCAL FIRST: updateOrderRail re-proves the evidence against fresh
 *     database state (expected rail + exactly-one verified network =
 *     target) inside its transaction. A no-row refusal is a hard stop with
 *     zero changes anywhere.
 *  2. Then push upstream (ordering-app orders only; BASE has no upstream
 *     value and is refused before anything is written). Read-check-write:
 *     a retry must not push the same correction twice. Every outcome of
 *     the upstream phase — skipped, pushed, failed, landed-despite-error —
 *     leaves a trail line on the order, written BEFORE the upstream
 *     mutation where one is about to happen.
 *
 * If the push fails, local and upstream disagree — but that state
 * self-heals: the next import copies the (still wrong) upstream
 * payment_method back over the local rail, the mismatch reappears, and the
 * correction is offered (or attempted by the pass) again.
 */

export type RailOrder = {
  id: number;
  external_id: string | null;
  payment_rail: string | null;
  /** raw_import.source — 'manual' orders exist only in this app, so a local-only correction is final */
  source?: string | null;
};

export type RailDeps = {
  settings: Record<string, string>;
  actor: string;
  updateRail: (p: { order_id: number; rail: string; expected_rail: string; actor: string; note: string }) => Promise<unknown>;
  appendNote: (p: { order_id: number; note: string; actor: string; detail: string }) => Promise<unknown>;
  /** appended to every trail line this correction writes, e.g. ' [auto-reconcile]' */
  tag?: string;
};

/** A trail line written on the order, with the admin_note the write returned (null when unknown). */
export type NoteWrite = { line: string; admin_note: string | null };

export type RailResult = {
  ok: boolean;
  /** the local rail changed (even when the upstream phase then failed) */
  localWritten: boolean;
  message: string;
  notes: NoteWrite[];
};

function adminNoteOf(res: unknown): string | null {
  const r = (Array.isArray(res) ? res[0] : res) as { admin_note?: string | null } | null | undefined;
  return r?.admin_note ?? null;
}

export async function correctOrderRail(o: RailOrder, newRail: string, deps: RailDeps): Promise<RailResult> {
  const notes: NoteWrite[] = [];
  const tag = deps.tag ?? '';
  const ts = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC]`;
  const upstreamValue = UPSTREAM_METHOD[newRail];
  // A manual order (created in this app) has no upstream and is never
  // re-imported, so its correction is local and final. For everything
  // else, no known upstream representation (BASE today) or no upstream id
  // means a local-only change would be silently reverted by the next
  // import — refuse instead of pretending. Callers never offer this case;
  // this is the backstop. (updateOrderRail itself refuses Base for every
  // caller, so a manual order can only be corrected to ETH or SOL.)
  const manual = o.source === 'manual';
  if (!manual && (!o.external_id || !upstreamValue)) {
    return { ok: false, localWritten: false, notes, message: 'This correction cannot be pushed to the ordering app (no upstream value for that network) — a local-only change would be reverted by the next import.' };
  }
  if (manual && !upstreamValue) {
    return { ok: false, localWritten: false, notes, message: `The rail can only be set to ETH or SOL (${newRail.toUpperCase()} is not a rail this app can reconcile an order on).` };
  }

  const localLine = `${ts} payment rail corrected ${o.payment_rail} → ${newRail}: payment verified on ${newRail.toUpperCase()}.${manual ? ' Manual order — nothing upstream to push.' : ''}${tag}`;
  const res = await deps.updateRail({ order_id: o.id, rail: newRail, expected_rail: o.payment_rail ?? '', actor: deps.actor, note: localLine });
  const wrote = Array.isArray(res) ? res.length > 0 : !!res;
  if (!wrote) {
    return { ok: false, localWritten: false, notes, message: 'Nothing changed — the order or its payments were modified since you opened it. Re-open the order and check.' };
  }
  notes.push({ line: localLine, admin_note: adminNoteOf(res) });
  if (manual || !o.external_id) {
    return { ok: true, localWritten: true, notes, message: `Rail corrected to ${newRail.toUpperCase()} — a manual order has no upstream to push to.` };
  }

  const cfg = { appId: deps.settings.base44_app_id || B44_DEFAULT_APP_ID, token: deps.settings.base44_token || '' };
  const appendNote = async (line: string, detail: Record<string, unknown>): Promise<boolean> => {
    try {
      const r = await deps.appendNote({ order_id: o.id, note: line, actor: deps.actor, detail: JSON.stringify(detail) });
      notes.push({ line, admin_note: adminNoteOf(r) });
      return true;
    } catch {
      return false; // surfaced in the message the caller shows
    }
  };

  // The read itself can fail (expired token, network) with the local rail
  // already committed — that must leave a trail line too, not just a thrown
  // error, so the whole upstream phase reports through the same failure path.
  let b44;
  try {
    b44 = await getB44Order(cfg, o.external_id);
  } catch (readErr: unknown) {
    const skipLine = `${ts} upstream payment_method push SKIPPED — could not read the ordering app (${readErr instanceof Error ? readErr.message : 'unknown error'}); nothing was changed upstream. Local rail is corrected; the next import will revert it and re-offer this correction.${tag}`;
    const skipNoted = await appendNote(skipLine, { rail_push_skipped: true });
    return {
      ok: false, localWritten: true, notes,
      message: skipNoted
        ? 'Local rail corrected, but the ordering app could not be reached — nothing was pushed. The next import will revert the local rail and re-offer this correction; retry then.'
        : 'Local rail corrected, but the ordering app could not be reached AND the audit note failed to write — record this manually in the admin notes. The next import will revert the local rail and re-offer this correction; retry then.',
    };
  }
  if (String(b44.payment_method || '') !== upstreamValue) {
    // Local trail BEFORE the upstream mutation — standing rule for anything
    // that changes the ordering app.
    const pushingLine = `${ts} pushing payment_method correction to the ordering app: ${upstreamValue} (${newRail.toUpperCase()}).${tag}`;
    // no trail line, no upstream mutation — the local rail stays corrected
    // and the next import reverts it, so the correction is offered again
    if (!(await appendNote(pushingLine, { rail_push: true, from: b44.payment_method || null, to: upstreamValue }))) {
      return {
        ok: false, localWritten: true, notes,
        message: 'Local rail corrected, but the audit note that must precede the ordering-app push could not be written — nothing was pushed. The next import will revert the local rail and re-offer this correction; retry then.',
      };
    }
    const line = `${ts} payment method corrected to ${upstreamValue} (${newRail.toUpperCase()}) by SND GB Ops — customer paid on ${newRail.toUpperCase()}.`;

    try {
      await updateB44Order(cfg, o.external_id, {
        payment_method: upstreamValue,
        notes: b44.notes ? `${b44.notes}\n${line}` : line,
      });
    } catch (pushErr: unknown) {
      // The trail must state the ACTUAL outcome of the attempt, not just
      // that one started — verify the FULL intended postcondition (method
      // AND the mirrored note). A matching method alone could be a partial
      // apply or someone else's concurrent fix; treating that as landed
      // would over-claim in both audit trails.
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
      const failLine = `${ts} payment_method push error (${pushErr instanceof Error ? pushErr.message : 'unknown error'}) — ${outcome}.${tag}`;
      const failNoted = await appendNote(failLine, { rail_push_error: true, landed });
      if (!landed) {
        return {
          ok: false, localWritten: true, notes,
          message: `Local rail corrected, but the ordering app push failed (${outcome}).${failNoted ? '' : ' The audit note ALSO failed to write — record this manually in the admin notes.'} The next import will revert the local rail and re-offer this correction — retry then.`,
        };
      }
    }
  }
  return { ok: true, localWritten: true, notes, message: `Rail corrected to ${newRail.toUpperCase()} and pushed to the ordering app.` };
}
