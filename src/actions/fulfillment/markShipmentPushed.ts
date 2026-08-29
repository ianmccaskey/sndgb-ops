import { action } from '@uibakery/data';

/**
 * Stamp b44_pushed_at AFTER the client's ordering-app push was sent AND
 * postcondition-verified (pushShipment.ts re-reads the upstream order and
 * checks every field landed). Until this stamp, the queue and the order
 * sheet keep an amber "not pushed" retry surface — a failed or unverified
 * push is never silently dropped. Refuses on a non-finalized or
 * already-stamped row (idempotent-safe: a double-fire is a no-op refusal,
 * not a second audit row). new_data records exactly what was pushed.
 */
function markShipmentPushed() {
  return action('markShipmentPushed', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE shipments s
        SET b44_pushed_at = now()
        WHERE s.id = {{params.shipment_id}}::bigint
          AND s.finalized_at IS NOT NULL
          AND s.b44_pushed_at IS NULL
        RETURNING s.id, s.order_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_pushed_upstream', {{params.actor}}::text,
             jsonb_build_object('order_id', up.order_id, 'pushed', {{params.pushed}}::jsonb)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default markShipmentPushed;
