import { action } from '@uibakery/data';

/**
 * The DURABLE completion evidence for an order the auto-adopt pass's
 * write-back completed upstream (status 'shipped' verified there): the
 * same audit row the shipment push's stamp writes (markShipmentPushed —
 * table 'shipments', action 'shipment_pushed_upstream', new_data.order_id
 * and pushed.status_set), because that row is what the digital-flip guard
 * (1786474500 set_product_digital) consumes before refusing to make a
 * completed order's digital line physical again. There is no shipment
 * row to stamp on this path (the completion came from vendor-direct
 * marks or earlier boxes), so row_pk names the order; `pushed.source`
 * says which path wrote it. Idempotent: a second row for the same order
 * is refused (zero rows) so a retried write-back never doubles it.
 */
function logUpstreamCompletion() {
  return action('logUpstreamCompletion', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.order_id}}::text, '')::bigint AS order_id,
               NULLIF({{params.actor}}::text, '') AS actor,
               NULLIF({{params.pushed}}::text, '')::jsonb AS pushed
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', 'order-' || inp.order_id::text, 'shipment_pushed_upstream', inp.actor,
             jsonb_build_object('order_id', inp.order_id, 'pushed', inp.pushed || jsonb_build_object('status_set', 'shipped', 'source', 'auto-adopt write-back'))
      FROM inp
      WHERE inp.order_id IS NOT NULL AND inp.actor IS NOT NULL AND inp.pushed IS NOT NULL
        AND EXISTS (SELECT 1 FROM orders o WHERE o.id = inp.order_id)
        AND NOT EXISTS (
          SELECT 1 FROM audit_log al
          WHERE al.table_name = 'shipments'
            AND al.action = 'shipment_pushed_upstream'
            AND (al.new_data->>'order_id')::bigint = inp.order_id
            AND al.new_data->'pushed'->>'status_set' = 'shipped')
      RETURNING id
    `,
  });
}

export default logUpstreamCompletion;
