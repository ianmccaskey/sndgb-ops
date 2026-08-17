import { action } from '@uibakery/data';

/**
 * Remove a mis-recorded vendor payment — the recovery path for a payment
 * with wrong amounts/breakdowns, and the required first step before a
 * campaign product with attributed kit payments can move to another vendor
 * (upsertCampaignProduct refuses vendor changes while payments reference
 * the line). Delete + audit are one statement; the audit row preserves the
 * full removed payment for reconstruction.
 *
 * A payment created by committing a STOCK PLAN line carries
 * stock_plan_item_id: deleting it atomically UN-STAMPS that plan line
 * (ordered_at/by/value cleared, audited) — an "ordered" plan line without
 * a live payment is unrepresentable, and the line reopens for a fresh
 * commit.
 */
function deleteVendorPayment() {
  return action('deleteVendorPayment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH del AS (
        DELETE FROM vendor_payments vp
        WHERE vp.id = {{params.id}}::bigint
          -- campaign-scoped like the list that displays it: a stale or
          -- cross-campaign id must not delete another campaign's payment
          AND vp.group_buy_id = {{params.group_buy_id}}::bigint
        RETURNING vp.*
      ), unstamp AS (
        UPDATE stock_plan_items i
        SET ordered_at = NULL, ordered_by = NULL, ordered_value_usd = NULL
        FROM del
        WHERE del.stock_plan_item_id IS NOT NULL
          AND i.id = del.stock_plan_item_id
        RETURNING i.id
      ), unstamp_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'stock_plan_items', unstamp.id::text, 'stock_plan_item_unstamped', {{params.actor}},
               jsonb_build_object('trigger', 'vendor_payment_deleted', 'vendor_payment_id', (SELECT id FROM del))
        FROM unstamp
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'vendor_payments', del.id::text, 'vendor_payment_deleted', {{params.actor}},
             to_jsonb(del.*)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteVendorPayment;
