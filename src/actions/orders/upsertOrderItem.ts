import { action } from '@uibakery/data';

/**
 * Upsert ONE order line item, keyed on (order_id, group_buy_product_id).
 * Single-row on purpose: UI Bakery's action layer rejects multi-row inserts
 * whose key columns repeat ("order_id must be unique"), which is what broke
 * the old replaceOrderItems. Returns no rows when the SKU doesn't match a
 * campaign product — the caller counts successes against the source list.
 */
function upsertOrderItem() {
  return action('upsertOrderItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO order_items (order_id, group_buy_product_id, qty, unit_price_usd)
      SELECT {{params.order_id}}::bigint, gbp.id, {{params.qty}}::int, gbp.gb_price_usd
      FROM products p
      JOIN group_buy_products gbp ON gbp.product_id = p.id
        AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
      WHERE p.sku_code = {{params.sku}}
      ON CONFLICT (order_id, group_buy_product_id) DO UPDATE SET
        qty = EXCLUDED.qty,
        unit_price_usd = EXCLUDED.unit_price_usd
      RETURNING id
    `,
  });
}

export default upsertOrderItem;
