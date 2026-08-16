import { action } from '@uibakery/data';

/**
 * Freight cost per vendor for one campaign, both kinds:
 *  - kit freight: the per-kit rate × final count (already inside product
 *    profit in P&L — shown here as the breakdown)
 *  - direct-ship freight: per-box rate × boxes across direct-ship order
 *    lines (a separate P&L deduction)
 */
function listFreightByVendor() {
  return action('listFreightByVendor', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT COALESCE(k.vendor_code, d.vendor_code) AS vendor_code,
             ROUND(COALESCE(k.kit_freight_usd, 0), 2) AS kit_freight_usd,
             ROUND(COALESCE(d.direct_freight_usd, 0), 2) AS direct_freight_usd,
             COALESCE(d.boxes, 0) AS boxes,
             ROUND(COALESCE(k.kit_freight_usd, 0) + COALESCE(d.direct_freight_usd, 0), 2) AS total_freight_usd
      FROM (
        SELECT vendor_code,
               SUM(CASE WHEN final_count > 0 THEN freight_usd * final_count ELSE 0 END) AS kit_freight_usd
        FROM v_product_profit
        WHERE group_buy_id = {{params.group_buy_id}}::bigint
        GROUP BY vendor_code
      ) k
      FULL JOIN (
        SELECT vendor_code,
               SUM(direct_freight_usd) AS direct_freight_usd,
               SUM(boxes) AS boxes
        FROM v_direct_freight
        WHERE group_buy_id = {{params.group_buy_id}}::bigint
        GROUP BY vendor_code
      ) d ON d.vendor_code = k.vendor_code
      WHERE COALESCE(k.kit_freight_usd, 0) + COALESCE(d.direct_freight_usd, 0) > 0
      ORDER BY 5 DESC, 1
    `,
  });
}

export default listFreightByVendor;
