import { action } from '@uibakery/data';

/**
 * Downgrade a draft's reservation after Shippo PROVED no label exists for
 * its rate (the exhaustive findTransactionByRate walk returned null):
 * clearing purchase_attempted_at drops the draft from the 30-day
 * "money may have moved" window to the 7-day rate-lifetime window, so a
 * pre-dispatch client failure cannot hold stock for a month once anyone
 * has run "Check Shippo & retry". The delete-guard lease
 * (purchase_started_at) is left untouched. Audited.
 */
function clearTransferAttemptVerified() {
  return action('clearTransferAttemptVerified', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET purchase_attempted_at = NULL
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
          AND t.purchase_attempted_at IS NOT NULL
        RETURNING t.id, t.shippo_rate_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_attempt_cleared_verified', {{params.actor}},
             jsonb_build_object('shippo_rate_id', up.shippo_rate_id, 'reason', 'shippo_verified_no_label')
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default clearTransferAttemptVerified;
