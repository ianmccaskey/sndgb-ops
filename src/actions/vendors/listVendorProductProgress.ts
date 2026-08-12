import { action } from '@uibakery/data';

/**
 * Per-product kit progress for the Vendors page: each campaign product's
 * kit demand (final count) against kits paid for via vendor payments
 * attributed to that product. Grouped under vendors in the UI, and the
 * source of the payment form's vendor-constrained product dropdown.
 */
function listVendorProductProgress() {
  return action('listVendorProductProgress', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT m.group_buy_product_id, m.vendor_code, m.sku_code,
             m.final_count AS kits_demand,
             m.vendor_order_value_usd,
             m.unit_cost_usd,
             -- blended per-kit vendor cost (folds tier-block ceilings in);
             -- falls back to the flat unit cost when nothing is owed yet
             CASE WHEN m.final_count > 0
               THEN ROUND(m.vendor_order_value_usd / m.final_count, 4)
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
      WHERE m.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY m.vendor_code, m.sku_code
    `,
  });
}

export default listVendorProductProgress;
