import { action } from '@uibakery/data';

/**
 * Correct an OTHER-item adjustment (1790102300) after the vendor changed
 * its price or the count: name, unit vendor cost and qty, with
 * expected_usd re-snapshotted as qty × cost. Ian, 2026-10-28: "The R10
 * was only charged at 30 a kit but our admin adjustment line had it
 * listed at 40 a kit. I can't edit the adjustment line to account for
 * the price change." An Other item has no demand, kits or freight, so
 * the new cost flows only where its cost already does: the vendor's
 * Other items owed, the party's payout deduction / net profit (group
 * stock) / the outside-customer receivable.
 *
 * The work is update_other_adjustment() (1790102800), a plpgsql
 * function, because the money already attributed to the item must be
 * read under the same per-vendor+campaign advisory lock (42002) the
 * batch recorder takes, in a statement of its own — otherwise a payment
 * batch attributed to the item that commits while this edit waits on
 * the row lock stays invisible to the edit's snapshot, and the new cost
 * could drop below money just paid (Codex review, 2026-10-28).
 *
 * Returns ONE row {id, refused}: id on success, else NULL with the reason
 * (nothing written). Refused when the row is not an Other item of THIS
 * campaign (campaign-scoped like every adjustment mutation); its customer
 * payment was already RECEIVED (closed at the old figure — a received
 * sale is history); a blank name, a non-positive or >2dp cost, a
 * non-whole qty; or the vendor has already been paid MORE for this item
 * than the new cost (vendor_payments attributed to it, 1790102600) — the
 * recorded payment, not the cost, is what is wrong then, so the batch
 * has to be removed first rather than the item silently reading as
 * over-paid. Vendor and assignment never change here: money is
 * attributed under (item, vendor, campaign), and a re-assignment is a
 * delete + re-add like a product row. Audited with the old and new
 * figures and the optional note.
 */
function updateOtherAdjustment() {
  return action('updateOtherAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT r.id, r.refused
      FROM update_other_adjustment(
        {{params.id}}::text,
        {{params.group_buy_id}}::text,
        {{params.other_name}}::text,
        {{params.unit_cost_usd}}::text,
        {{params.qty}}::text,
        {{params.note}}::text,
        {{params.actor}}::text
      ) r
    `,
  });
}

export default updateOtherAdjustment;
