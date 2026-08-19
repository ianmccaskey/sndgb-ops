import { action } from '@uibakery/data';

/**
 * Record a refund request's status on a FINALIZED transfer. The refund
 * itself was requested at Shippo by the client; USPS refunds settle over
 * days, so this is a status marker ("check the Shippo dashboard"), not a
 * settlement record. 'REQUESTING' is persisted BEFORE the Shippo POST so
 * a browser death mid-request leaves durable evidence and blocks repeat
 * submissions; an empty status CLEARS the marker (only the reconcile
 * flow does this, after an exhaustive Shippo listing proves no refund
 * exists). Audited.
 */
function setTransferRefund() {
  return action('setTransferRefund', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET refund_status = NULLIF(TRIM({{params.refund_status}}::text), '')
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NOT NULL
          -- 'REQUESTING' is a one-way COMPARE-AND-SET: it only lands on a
          -- row with no refund status, so two admins racing the button end
          -- with ONE Shippo refund POST (the loser gets zero rows). Real
          -- statuses and clears (from the POST result / Re-check) are free.
          AND (NULLIF(TRIM({{params.refund_status}}::text), '') IS DISTINCT FROM 'REQUESTING' OR t.refund_status IS NULL)
        RETURNING t.id, t.refund_status, t.shippo_transaction_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_refund_status_set', {{params.actor}},
             jsonb_build_object('refund_status', up.refund_status, 'shippo_transaction_id', up.shippo_transaction_id)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default setTransferRefund;
