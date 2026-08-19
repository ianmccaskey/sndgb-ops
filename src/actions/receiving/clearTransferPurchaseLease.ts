import { action } from '@uibakery/data';

/**
 * Release the PURCHASE LEASE after Shippo DEFINITIVELY refused the label
 * (ERROR-status transaction — no charge, no label). Only that path calls
 * this: ambiguous failures (network drop, 5xx, poll timeout) keep the
 * lease, because money may have moved and the draft must stay
 * undeletable until verified. Clearing lets an honest retry or a
 * verified delete proceed immediately instead of waiting out the
 * 10-minute window. Audited.
 */
function clearTransferPurchaseLease() {
  return action('clearTransferPurchaseLease', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET purchase_started_at = NULL
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
        RETURNING t.id, t.shippo_rate_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_purchase_lease_cleared', {{params.actor}},
             jsonb_build_object('shippo_rate_id', up.shippo_rate_id, 'reason', 'shippo_refused')
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default clearTransferPurchaseLease;
