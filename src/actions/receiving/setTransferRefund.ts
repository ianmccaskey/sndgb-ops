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
        SET refund_status = NULLIF(TRIM({{params.refund_status}}::text), ''),
            refund_requested_at = CASE WHEN NULLIF(TRIM({{params.refund_status}}::text), '') = 'REQUESTING'
                                       THEN now() ELSE t.refund_requested_at END
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NOT NULL
          -- 'REQUESTING' is a one-way COMPARE-AND-SET: it only lands on a
          -- row with no refund status, so two admins racing the button end
          -- with ONE Shippo refund POST (the loser gets zero rows).
          AND (NULLIF(TRIM({{params.refund_status}}::text), '') IS DISTINCT FROM 'REQUESTING' OR t.refund_status IS NULL)
          -- a CLEAR (empty status) refuses while a REQUESTING marker is
          -- fresher than 10 minutes: another session's Shippo POST may be
          -- in flight and not yet listed — wiping its marker would
          -- re-enable a duplicate refund request. Real statuses are free.
          AND (NULLIF(TRIM({{params.refund_status}}::text), '') IS NOT NULL
               OR t.refund_status IS DISTINCT FROM 'REQUESTING'
               OR t.refund_requested_at IS NULL
               OR t.refund_requested_at < now() - interval '10 minutes')
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
