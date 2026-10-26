import { action } from '@uibakery/data';

/**
 * At-cost adjustments still AWAITING the customer's payment for this
 * campaign — expected incoming money, shown as its own Sankey source
 * (distinct from profit already sitting in the wallets). Product rows and
 * Other-item rows alike (1790102300; sku_code is the item's typed name).
 */
function listAtCostReceivables() {
  return action('listAtCostReceivables', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT a.id, COALESCE(p.sku_code, a.other_name) AS sku_code, a.qty, a.expected_usd, a.reason, a.created_at, a.preordered
      FROM admin_adjustments a
      LEFT JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
      LEFT JOIN products p ON p.id = gbp.product_id
      WHERE a.group_buy_id = {{params.group_buy_id}}::bigint
        AND a.pricing = 'cost'
        -- only OUTSIDE-customer sales are receivables; personal at-cost
        -- stock (party beneficiary) settles against the party's payout,
        -- and GROUP STOCK (planner commits and direct adjustments alike)
        -- comes out of net profit — nobody pays the group back for its
        -- own stock
        AND a.beneficiary = 'both'
        AND NOT a.stock
        AND a.received_at IS NULL
      ORDER BY a.created_at DESC
    `,
  });
}

export default listAtCostReceivables;
