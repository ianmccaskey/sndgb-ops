import { action } from '@uibakery/data';

function getMoqProgress() {
  return action('getMoqProgress', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT group_buy_product_id, sku_code, product_name, mass_label, vendor_code,
             target_moq, demand_qty, adjustment_qty, final_count, moq_met,
             gb_price_usd, vendor_order_value_usd
      FROM v_moq_progress
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY sku_code
    `,
  });
}

export default getMoqProgress;
