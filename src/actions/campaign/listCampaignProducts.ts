import { action } from '@uibakery/data';

function listCampaignProducts() {
  return action('listCampaignProducts', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT vpp.group_buy_product_id, vpp.group_buy_id, vpp.sku_code, vpp.product_name, vpp.mass_label,
             vpp.vendor_code, vpp.unit_cost_usd, vpp.margin_usd, vpp.gb_price_usd, vpp.target_moq,
             vpp.demand_qty, vpp.adjustment_qty, vpp.final_count, vpp.moq_met, vpp.vendor_order_value_usd,
             vpp.testing_cost_usd, vpp.freight_usd, vpp.testing_per_unit_usd, vpp.freight_per_unit_usd,
             vpp.net_profit_per_unit_usd, vpp.total_product_profit_usd,
             vpp.owed_to_vendor_usd, vpp.expected_revenue_usd, vpp.ordered_from_vendor_at, vpp.status,
             gbp.qty_cap, gbp.cost_tier_qty, gbp.cost_tier_price,
             gbp.direct_freight_usd, gbp.direct_box_kits, gbp.split_fee_usd
      FROM v_product_profit vpp
      JOIN group_buy_products gbp ON gbp.id = vpp.group_buy_product_id
      WHERE vpp.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY vpp.sku_code
    `,
  });
}

export default listCampaignProducts;
