import { action } from '@uibakery/data';

/**
 * Every adjustment of the campaign, product rows and Other-item rows alike
 * (1790102300). sku_code is the display label: the product's SKU, or the
 * Other item's typed name; other_name / vendor_code / other_unit_cost_usd
 * are set only on Other rows. value_usd is qty × GB price for a product
 * row and the cost snapshot for an Other row (which has no GB price).
 */
function listAdjustments() {
  return action('listAdjustments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT a.id, a.group_buy_product_id, a.qty, a.reason, a.created_by, a.created_at, a.beneficiary,
             a.pricing, a.expected_usd, a.received_at, a.preordered, a.stock_plan_item_id, a.stock,
             CASE WHEN gbp.id IS NOT NULL THEN a.qty * gbp.gb_price_usd ELSE a.expected_usd END AS value_usd,
             COALESCE(p.sku_code, a.other_name) AS sku_code,
             a.other_name, a.other_unit_cost_usd, a.vendor_id, v.code AS vendor_code
      FROM admin_adjustments a
      LEFT JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
      LEFT JOIN products p ON p.id = gbp.product_id
      LEFT JOIN vendors v ON v.id = a.vendor_id
      WHERE a.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY a.created_at DESC
    `,
  });
}

export default listAdjustments;
