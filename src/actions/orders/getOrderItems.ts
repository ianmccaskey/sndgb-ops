import { action } from '@uibakery/data';

function getOrderItems() {
  return action('getOrderItems', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT oi.id, oi.qty, oi.unit_price_usd, (oi.qty * oi.unit_price_usd) AS line_total_usd,
             oi.comp_qty, oi.comp_reason,
             (LEAST(oi.comp_qty, CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) * oi.unit_price_usd) AS comp_value_usd,
             oi.direct_ship, oi.direct_ship_source, oi.direct_fulfilled_at, oi.item_source,
             oi.qty_override, oi.removed_at, oi.split_fee_usd,
             p.sku_code, p.name AS product_name, p.mass_label, p.external_id AS product_external_id
      FROM order_items oi
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      WHERE oi.order_id = {{params.order_id}}::bigint
      ORDER BY p.sku_code
    `,
  });
}

export default getOrderItems;
