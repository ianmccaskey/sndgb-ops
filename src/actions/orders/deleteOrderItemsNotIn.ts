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
      DELETE FROM order_items oi
      WHERE oi.order_id = {{params.order_id}}::bigint
        -- locally added items are invisible to the ordering app by
        -- definition — its item list must never prune them; locally REMOVED
        -- rows only leave via importUpsertOrder's total-gated retirement, so
        -- a partial push can't silently drop the removal marker
        AND oi.item_source <> 'local'
        AND oi.removed_at IS NULL
        AND oi.group_buy_product_id NOT IN (
          SELECT gbp.id
          FROM jsonb_to_recordset({{params.items}}::jsonb) AS x(sku text, qty numeric)
          JOIN products p ON p.sku_code = x.sku
          JOIN group_buy_products gbp ON gbp.product_id = p.id
            AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
        )
      RETURNING oi.id
    `,
  });
}

export default deleteOrderItemsNotIn;
