import { action } from '@uibakery/data';

/**
 * Progress a SPECIFIC finalized shipment's status forward — shipped →
 * delivered / reshipped (and between those two, for a box that came back
 * and went out again). Never backward: a purchased label cannot un-ship;
 * a mistake is handled by the refund flow, which voids the row entirely.
 * Drafts refuse — a draft has no status semantics until finalize. Targets
 * one shipment id, never "the latest". Audited.
 */
function updateShipmentStatus() {
  return action('updateShipmentStatus', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT s.id AS sid, pg_advisory_xact_lock(42001, s.order_id::int) AS locked
        FROM shipments s
        WHERE s.id = {{params.shipment_id}}::bigint
      ),
      up AS (
        UPDATE shipments s
        SET status = {{params.status}}::text::shipment_status,
            note = COALESCE(NULLIF(TRIM({{params.note}}::text), ''), s.note)
        FROM lck
        WHERE s.id = lck.sid
          AND s.finalized_at IS NOT NULL
          AND COALESCE(s.refund_status, '') <> 'SUCCESS'
          AND {{params.status}}::text IN ('delivered', 'reshipped')
          AND s.status IN ('shipped', 'delivered', 'reshipped')
          AND s.status::text <> {{params.status}}::text
        RETURNING s.id, s.order_id, s.status
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_status_changed', {{params.actor}}::text,
             jsonb_build_object('order_id', up.order_id, 'status', up.status)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default updateShipmentStatus;
