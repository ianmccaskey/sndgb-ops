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
        AND oi.group_buy_product_id NOT IN (
          SELECT gbp.id
          FROM jsonb_to_recordset({{params.items}}::jsonb) AS x(sku text, qty int)
          JOIN products p ON p.sku_code = x.sku
          JOIN group_buy_products gbp ON gbp.product_id = p.id
            AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
        )
      RETURNING oi.id
    `,
  });
}

export default deleteOrderItemsNotIn;
