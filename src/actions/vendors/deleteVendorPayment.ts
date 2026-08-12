import { action } from '@uibakery/data';

/**
 * Remove a mis-recorded vendor payment — the recovery path for a payment
 * with wrong amounts/breakdowns, and the required first step before a
 * campaign product with attributed kit payments can move to another vendor
 * (upsertCampaignProduct refuses vendor changes while payments reference
 * the line). Delete + audit are one statement; the audit row preserves the
 * full removed payment for reconstruction.
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
