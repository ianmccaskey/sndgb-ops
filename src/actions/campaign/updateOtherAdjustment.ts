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
      WITH inp AS (
        SELECT NULLIF(btrim({{params.other_name}}::text), '') AS other_name,
               CASE WHEN btrim({{params.unit_cost_usd}}::text) ~ '^[0-9]+(\\.[0-9]{1,2})?$' THEN btrim({{params.unit_cost_usd}}::text)::numeric END AS unit_cost,
               CASE WHEN btrim({{params.qty}}::text) ~ '^[0-9]+$' THEN btrim({{params.qty}}::text)::numeric END AS qty
      ), tgt AS (
        SELECT a.id, a.other_name, a.other_unit_cost_usd, a.qty, a.expected_usd, a.received_at,
               COALESCE((
                 SELECT SUM(vp.amount_usd) FROM vendor_payments vp WHERE vp.admin_adjustment_id = a.id
               ), 0) AS paid_usd
        FROM admin_adjustments a
        WHERE a.id = {{params.id}}::bigint
          AND a.group_buy_id = {{params.group_buy_id}}::bigint
          AND a.group_buy_product_id IS NULL
        FOR UPDATE OF a
      ), refusal AS (
        SELECT CASE
                 WHEN NOT EXISTS (SELECT 1 FROM tgt) THEN 'not an Other item of this campaign'
                 WHEN (SELECT t.received_at FROM tgt t) IS NOT NULL THEN 'its customer payment was received at the old figure — a received sale is closed'
                 WHEN i.other_name IS NULL THEN 'name is required'
                 WHEN i.unit_cost IS NULL OR i.unit_cost <= 0 THEN 'unit cost must be a positive $ amount with at most 2 decimals'
                 WHEN i.qty IS NULL OR i.qty <= 0 THEN 'qty must be a positive whole number'
                 WHEN ROUND(i.qty * i.unit_cost, 2) < (SELECT t.paid_usd FROM tgt t)
                   THEN 'the vendor has already been paid ' || (SELECT t.paid_usd FROM tgt t)::text || ' for it, more than the new cost — remove that payment batch on the Vendors page first'
               END AS why
        FROM inp i
      ), upd AS (
        UPDATE admin_adjustments a
        SET other_name = i.other_name,
            other_unit_cost_usd = i.unit_cost,
            qty = i.qty,
            expected_usd = ROUND(i.qty * i.unit_cost, 2)
        FROM inp i, tgt t
        WHERE a.id = t.id
          AND NOT EXISTS (SELECT 1 FROM refusal r WHERE r.why IS NOT NULL)
        RETURNING a.id, a.other_name, a.other_unit_cost_usd, a.qty, a.expected_usd
      ), aud AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'admin_adjustments', u.id::text, 'other_adjustment_updated', COALESCE(NULLIF({{params.actor}}::text, ''), 'operator'),
               jsonb_build_object('other_name', t.other_name, 'unit_cost_usd', t.other_unit_cost_usd, 'qty', t.qty,
                                  'expected_usd', t.expected_usd, 'paid_usd', t.paid_usd),
               jsonb_build_object('other_name', u.other_name, 'unit_cost_usd', u.other_unit_cost_usd, 'qty', u.qty,
                                  'expected_usd', u.expected_usd, 'note', NULLIF(btrim({{params.note}}::text), ''))
        FROM upd u, tgt t
        RETURNING row_pk
      )
      SELECT (SELECT u.id FROM upd u) AS id,
             (SELECT r.why FROM refusal r WHERE r.why IS NOT NULL) AS refused
    `,
  });
}

export default updateOtherAdjustment;
