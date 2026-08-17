import { action } from '@uibakery/data';

function listAdjustments() {
  return action('listAdjustments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT a.id, a.group_buy_product_id, a.qty, a.reason, a.created_by, a.created_at, a.beneficiary,
             a.pricing, a.expected_usd, a.received_at, a.preordered,
             (a.qty * gbp.gb_price_usd) AS value_usd,
             p.sku_code
      FROM admin_adjustments a
      JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      WHERE gbp.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY a.created_at DESC
    `,
  });
}

export default listAdjustments;
