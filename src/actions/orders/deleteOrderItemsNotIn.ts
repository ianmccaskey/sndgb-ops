import { action } from '@uibakery/data';

/**
 * Remove an order's line items whose product is no longer in the source item
 * list (an item deleted upstream). The caller must never send an empty list —
 * the import refuses zero-item orders before reaching this.
 */
function deleteOrderItemsNotIn() {
  return action('deleteOrderItemsNotIn', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH src AS (
        SELECT gbp.id
        FROM jsonb_to_recordset({{params.items}}::jsonb) AS x(sku text, qty numeric)
        JOIN products p ON p.sku_code = x.sku
        JOIN group_buy_products gbp ON gbp.product_id = p.id
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
      )
      DELETE FROM order_items oi
      WHERE oi.order_id = {{params.order_id}}::bigint
        -- locally added items are invisible to the ordering app by
        -- definition — its item list must never prune them; locally REMOVED
        -- rows only leave via importUpsertOrder's total-gated retirement, so
        -- a partial push can't silently drop the removal marker
        AND oi.item_source <> 'local'
        AND oi.removed_at IS NULL
        AND oi.group_buy_product_id NOT IN (SELECT id FROM src)
        -- never strand an ACTIVE order with zero active lines: pruning only
        -- proceeds when some active line SURVIVES it (a local row, or one
        -- upstream still carries). When the only upstream line left maps to
        -- a locally-removed row, nothing prunes — the stale superset stays
        -- (the app's standing prune-failure semantics) until the operator
        -- restores the removed line or cancels the order.
        AND EXISTS (
          SELECT 1 FROM order_items oj
          WHERE oj.order_id = oi.order_id
            AND oj.id <> oi.id
            AND oj.removed_at IS NULL
            AND (oj.item_source = 'local' OR oj.group_buy_product_id IN (SELECT id FROM src))
        )
      RETURNING oi.id
    `,
  });
}

export default deleteOrderItemsNotIn;
