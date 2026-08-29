import { action } from '@uibakery/data';

/**
 * Record a refund request's status on a FINALIZED shipment. The refund
 * itself was requested at Shippo by the client; USPS refunds settle over
 * days, so this is a status marker ("check the Shippo dashboard"), not a
 * settlement record. 'REQUESTING' is persisted BEFORE the Shippo POST so
 * a browser death mid-request leaves durable evidence and blocks repeat
 * submissions; an empty status CLEARS the marker (only the reconcile flow
 * does this, after an exhaustive Shippo listing proves no refund exists).
 * A 'SUCCESS' status VOIDS the shipment everywhere: its attribution
 * returns to remaining-to-pack and the order re-enters the ready queue.
 * Audited.
 */
function setShipmentRefund() {
  return action('setShipmentRefund', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT s.id AS sid, pg_advisory_xact_lock(42001, s.order_id::int) AS locked
        FROM shipments s
        WHERE s.id = {{params.shipment_id}}::bigint
      ),
      up AS (
        UPDATE shipments s
        SET refund_status = NULLIF(TRIM({{params.refund_status}}::text), ''),
            refund_requested_at = CASE WHEN NULLIF(TRIM({{params.refund_status}}::text), '') = 'REQUESTING'
                                       THEN now() ELSE s.refund_requested_at END
        FROM lck
        WHERE s.id = lck.sid
          AND s.finalized_at IS NOT NULL
          -- 'REQUESTING' is a one-way COMPARE-AND-SET: it lands only on a
          -- row with no refund status (first request — two admins racing
          -- end with ONE Shippo POST) or on the caller's OWN standing
          -- marker (heartbeat: prior_requested_at matches exactly), which
          -- re-stamps it just before the POST so a tab that slept past the
          -- window learns its marker was cleared/superseded and aborts
          AND (NULLIF(TRIM({{params.refund_status}}::text), '') IS DISTINCT FROM 'REQUESTING'
               OR s.refund_status IS NULL
               OR ({{params.prior_requested_at}}::text <> '' AND s.refund_status = 'REQUESTING' AND s.refund_requested_at = {{params.prior_requested_at}}::timestamptz))
          -- a CLEAR (empty status) refuses while a REQUESTING marker is
          -- fresher than 10 minutes: another session's Shippo POST may be
          -- in flight and not yet listed — wiping its marker would
          -- re-enable a duplicate refund request. Real statuses are free.
          AND (NULLIF(TRIM({{params.refund_status}}::text), '') IS NOT NULL
               OR s.refund_status IS DISTINCT FROM 'REQUESTING'
               OR s.refund_requested_at IS NULL
               OR s.refund_requested_at < now() - interval '10 minutes')
        RETURNING s.id, s.order_id, s.refund_status, s.shippo_transaction_id, s.refund_requested_at
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_refund_status_set', {{params.actor}}::text,
             jsonb_build_object('order_id', up.order_id, 'refund_status', up.refund_status,
                                'shippo_transaction_id', up.shippo_transaction_id,
                                'requested_at', up.refund_requested_at)
      FROM up
      RETURNING row_pk AS id, (new_data->>'requested_at') AS requested_at
    `,
  });
}

export default setShipmentRefund;
