import { action } from '@uibakery/data';

/**
 * Mark an order's vendor-direct lines as shipped by the vendor (or undo).
 * Sets direct_fulfilled_at on the order's direct_ship lines that are in the
 * opposite state — the direct-tab row disappears once nothing is outstanding.
 * item_id narrows it to ONE line (partial vendor shipments — e.g. two direct
 * SKUs from different vendors complete separately); blank = every line, the
 * queue's bulk button, whose confirm dialog lists exactly what it stamps.
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
          AND (NULLIF({{params.item_id}}::text, '')::bigint IS NULL
               OR oi.id = NULLIF({{params.item_id}}::text, '')::bigint)
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
