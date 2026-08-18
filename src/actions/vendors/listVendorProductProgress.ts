import { action } from '@uibakery/data';

/**
 * Per-product kit progress for the Vendors page: each campaign product's
 * kit demand (ordered_kits — the vendor sells WHOLE kits, so half-kit
 * demand rounds up) against kits paid for via vendor payments attributed
 * to that product. Grouped under vendors in the UI, and the source of the
 * payment form's vendor-constrained product dropdown.
 *
 * Also splits demand into ORDERS vs ADMIN ADJUSTMENTS so the page can show
 * that adjustment kits really are inside the purchase numbers: orders_kits
 * (customer demand) + adj_kits (demand-contributing adjustments — matches
 * v_moq_progress, so preordered at-cost rows are excluded) with adj_detail
 * per kind: GB-price admin rows, outside at-cost sales, personal stock,
 * and stock-plan commits.
 */
function listVendorProductProgress() {
  return action('listVendorProductProgress', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT m.group_buy_product_id, m.vendor_code, m.sku_code,
             m.ordered_kits AS kits_demand,
             m.demand_qty AS orders_kits,
             m.adjustment_qty AS adj_kits,
             adj.adj_detail,
             m.vendor_order_value_usd,
             m.unit_cost_usd,
             -- blended per-kit vendor cost (folds tier-block ceilings in);
             -- falls back to the flat unit cost when nothing is owed yet
             CASE WHEN m.ordered_kits > 0
               THEN ROUND(m.vendor_order_value_usd / m.ordered_kits, 4)
               ELSE m.unit_cost_usd END AS per_kit_cost_usd,
             COALESCE(vp.kits_paid, 0) AS kits_paid
      FROM v_moq_progress m
      LEFT JOIN (
        SELECT group_buy_product_id, SUM(COALESCE(kits_qty, 0)) AS kits_paid
        FROM vendor_payments
        WHERE group_buy_id = {{params.group_buy_id}}::bigint
          AND group_buy_product_id IS NOT NULL
        GROUP BY group_buy_product_id
      ) vp ON vp.group_buy_product_id = m.group_buy_product_id
      LEFT JOIN (
        -- per-kind adjustment kits, same inclusion rule as demand:
        -- preordered at-cost rows contribute NO demand, so they are not
        -- part of the purchase numbers and stay out of this breakdown.
        -- Campaign-scoped BEFORE aggregating (like the kits_paid subquery)
        -- so the page never scans other campaigns' adjustment history.
        SELECT t.group_buy_product_id,
               jsonb_agg(jsonb_build_object('kind', t.kind, 'qty', t.qty) ORDER BY t.kind) AS adj_detail
        FROM (
          SELECT a.group_buy_product_id,
                 CASE WHEN a.pricing = 'gb' THEN 'admin'
                      WHEN a.stock_plan_item_id IS NOT NULL THEN 'stock plan'
                      WHEN a.beneficiary <> 'both' THEN 'personal: ' || a.beneficiary
                      ELSE 'outside sale' END AS kind,
                 SUM(a.qty) AS qty
          FROM admin_adjustments a
          JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
            AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
          WHERE NOT (a.pricing = 'cost' AND a.preordered)
          GROUP BY 1, 2
        ) t
        GROUP BY t.group_buy_product_id
      ) adj ON adj.group_buy_product_id = m.group_buy_product_id
      WHERE m.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY m.vendor_code, m.sku_code
    `,
  });
}

export default listVendorProductProgress;
