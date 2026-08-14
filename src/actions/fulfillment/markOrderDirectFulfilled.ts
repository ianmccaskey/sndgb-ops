import { action } from '@uibakery/data';

/**
 * Mark an order's vendor-direct lines as shipped by the vendor (or undo).
 * Sets direct_fulfilled_at on the order's direct_ship lines that are in the
 * opposite state — the direct-tab row disappears once nothing is outstanding.
 * Independent of the local shipment record on purpose: a mixed order's two
 * halves complete separately. One statement, audited with the touched item
 * ids; zero rows = nothing was in the requested state (refusal).
 */
function markOrderDirectFulfilled() {
  return action('markOrderDirectFulfilled', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE order_items oi SET
          direct_fulfilled_at = CASE WHEN {{params.fulfilled}}::boolean THEN now() ELSE NULL END
        WHERE oi.order_id = {{params.order_id}}::bigint
          AND oi.direct_ship
          AND (({{params.fulfilled}}::boolean AND oi.direct_fulfilled_at IS NULL)
               OR (NOT {{params.fulfilled}}::boolean AND oi.direct_fulfilled_at IS NOT NULL))
        RETURNING oi.id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_items', {{params.order_id}}::text,
             CASE WHEN {{params.fulfilled}}::boolean THEN 'direct_marked_fulfilled' ELSE 'direct_fulfillment_undone' END,
             {{params.actor}},
             jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                'item_ids', (SELECT jsonb_agg(upd.id) FROM upd),
                                'fulfilled', {{params.fulfilled}}::boolean)
      WHERE EXISTS (SELECT 1 FROM upd)
      RETURNING row_pk AS id
    `,
  });
}

export default markOrderDirectFulfilled;
