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
          -- 'REQUESTING' is a one-way COMPARE-AND-SET: it lands only on a
          -- row with no refund status (first request — two admins racing
          -- end with ONE Shippo POST) or on the caller's OWN standing
          -- marker (heartbeat: prior_requested_at matches exactly), which
          -- re-stamps it just before the POST so a tab that slept past the
          -- window learns its marker was cleared/superseded and aborts
          AND (NULLIF(TRIM({{params.refund_status}}::text), '') IS DISTINCT FROM 'REQUESTING'
               OR t.refund_status IS NULL
               OR ({{params.prior_requested_at}}::text <> '' AND t.refund_status = 'REQUESTING' AND t.refund_requested_at = {{params.prior_requested_at}}::timestamptz))
          -- a CLEAR (empty status) refuses while a REQUESTING marker is
          -- fresher than 10 minutes: another session's Shippo POST may be
          -- in flight and not yet listed — wiping its marker would
          -- re-enable a duplicate refund request. Real statuses are free.
          AND (NULLIF(TRIM({{params.refund_status}}::text), '') IS NOT NULL
               OR t.refund_status IS DISTINCT FROM 'REQUESTING'
               OR t.refund_requested_at IS NULL
               OR t.refund_requested_at < now() - interval '10 minutes')
        RETURNING t.id, t.refund_status, t.shippo_transaction_id, t.refund_requested_at
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_refund_status_set', {{params.actor}},
             jsonb_build_object('refund_status', up.refund_status, 'shippo_transaction_id', up.shippo_transaction_id,
                                'requested_at', up.refund_requested_at)
      FROM up
      RETURNING row_pk AS id, (new_data->>'requested_at') AS requested_at
    `,
  });
}

export default setTransferRefund;
