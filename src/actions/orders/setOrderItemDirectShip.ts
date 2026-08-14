import { action } from '@uibakery/data';

/**
 * Manually mark (or unmark) an order line as direct-shipped by the vendor.
 * Sets direct_ship_source = 'manual' so imports never clobber the operator's
 * decision — upsertOrderItem only refreshes 'upstream'-sourced rows.
 *
 * No advisory lock and no write-off clearing on purpose: direct-ship moves
 * no money — it feeds fulfillment routing only, never reconciliation.
 * Update + audit are one statement; refused (no rows) when the item does not
 * belong to the order.
 */
function setOrderItemDirectShip() {
  return action('setOrderItemDirectShip', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH prev AS (
        SELECT oi.id, oi.direct_ship, oi.direct_ship_source
        FROM order_items oi
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
      ), upd AS (
        UPDATE order_items oi SET
          direct_ship = {{params.direct_ship}}::boolean,
          direct_ship_source = 'manual',
          -- turning a line direct that wasn't must not inherit an old
          -- fulfillment timestamp — the vendor owes this line NOW
          direct_fulfilled_at = CASE
            WHEN {{params.direct_ship}}::boolean AND NOT oi.direct_ship THEN NULL
            ELSE oi.direct_fulfilled_at
          END
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
        RETURNING oi.id, oi.direct_ship
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_items', upd.id::text, 'direct_ship_set', {{params.actor}},
             jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                'old_direct_ship', prev.direct_ship,
                                'old_source', prev.direct_ship_source,
                                'new_direct_ship', upd.direct_ship)
      FROM upd
      JOIN prev ON prev.id = upd.id
      RETURNING row_pk AS id
    `,
  });
}

export default setOrderItemDirectShip;
