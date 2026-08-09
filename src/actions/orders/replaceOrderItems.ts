import { action } from '@uibakery/data';

/**
 * Replaces an order's line items from a JSON array of {sku, qty}.
 * SKUs must exist as campaign products — the import screen validates this
 * before calling, and the returned inserted_count lets the caller detect
 * any row that still failed to match instead of silently dropping it.
 */
function replaceOrderItems() {
  return action('replaceOrderItems', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH del AS (
        DELETE FROM order_items WHERE order_id = {{params.order_id}}::bigint
      ), src AS (
        SELECT x.sku, x.qty
        FROM jsonb_to_recordset({{params.items}}::jsonb) AS x(sku text, qty int)
      ), matched AS (
        SELECT gbp.id AS gbp_id, src.qty, gbp.gb_price_usd
        FROM src
        JOIN products p ON p.sku_code = src.sku
        JOIN group_buy_products gbp ON gbp.product_id = p.id
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
      ), ins AS (
        INSERT INTO order_items (order_id, group_buy_product_id, qty, unit_price_usd)
        SELECT {{params.order_id}}::bigint, gbp_id, qty, gb_price_usd FROM matched
        RETURNING id
      )
      SELECT (SELECT COUNT(*) FROM src) AS source_count,
             (SELECT COUNT(*) FROM ins) AS inserted_count
    `,
  });
}

export default replaceOrderItems;
