import { action } from '@uibakery/data';

function getOrderItems() {
  return action('getOrderItems', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT oi.id, oi.qty, oi.unit_price_usd, (oi.qty * oi.unit_price_usd) AS line_total_usd,
             p.sku_code, p.name AS product_name, p.mass_label
      FROM order_items oi
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      WHERE oi.order_id = {{params.order_id}}::bigint
      ORDER BY p.sku_code
    `,
  });
}

export default getOrderItems;
