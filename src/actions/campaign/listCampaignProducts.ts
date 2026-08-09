import { action } from '@uibakery/data';

function listCampaignProducts() {
  return action('listCampaignProducts', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT group_buy_product_id, group_buy_id, sku_code, product_name, mass_label,
             vendor_code, unit_cost_usd, margin_usd, gb_price_usd, target_moq,
             demand_qty, adjustment_qty, final_count, moq_met, vendor_order_value_usd,
             testing_cost_usd, freight_usd, testing_per_unit_usd, freight_per_unit_usd,
             net_profit_per_unit_usd, total_product_profit_usd,
             owed_to_vendor_usd, expected_revenue_usd, ordered_from_vendor_at, status
      FROM v_product_profit
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY sku_code
    `,
  });
}

export default listCampaignProducts;
