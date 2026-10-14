import { action } from '@uibakery/data';

/**
 * Units ordered and order count per PHYSICAL campaign product (digital COA
 * add-ons excluded via products.digital, the flag fulfillment already keys
 * on). Units use the same effective-qty rule as v_moq_progress.demand_qty —
 * qty_override wins, removed lines and cancelled/refunded orders drop out —
 * so the figures agree with MOQ demand. Orders only: admin adjustments are
 * not included (the MOQ card shows those).
 */
function getProductOrderCounts() {
  return action('getProductOrderCounts', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT gbp.id AS group_buy_product_id, p.sku_code,
             COALESCE(d.units, 0) AS units,
             COALESCE(d.order_count, 0) AS order_count
      FROM group_buy_products gbp
      JOIN products p ON p.id = gbp.product_id
      LEFT JOIN (
        SELECT oi.group_buy_product_id,
               SUM(COALESCE(oi.qty_override, oi.qty)) AS units,
               COUNT(DISTINCT oi.order_id) AS order_count
        FROM order_items oi
        JOIN orders o ON o.id = oi.order_id
        WHERE o.status <> ALL (ARRAY['cancelled'::order_status, 'refunded'::order_status])
          AND oi.removed_at IS NULL
          AND COALESCE(oi.qty_override, oi.qty) > 0
        GROUP BY oi.group_buy_product_id
      ) d ON d.group_buy_product_id = gbp.id
      WHERE gbp.group_buy_id = {{params.group_buy_id}}::bigint
        AND NOT p.digital
        AND (gbp.status = 'active' OR COALESCE(d.units, 0) > 0)
      ORDER BY units DESC, p.sku_code
    `,
  });
}

export default getProductOrderCounts;
