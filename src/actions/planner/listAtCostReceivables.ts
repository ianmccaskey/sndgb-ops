import { action } from '@uibakery/data';

/**
 * At-cost adjustments still AWAITING the customer's payment for this
 * campaign — expected incoming money, shown as its own Sankey source
 * (distinct from profit already sitting in the wallets).
 */
function listAtCostReceivables() {
  return action('listAtCostReceivables', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT a.id, p.sku_code, a.qty, a.expected_usd, a.reason, a.created_at, a.preordered
      FROM admin_adjustments a
      JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      WHERE gbp.group_buy_id = {{params.group_buy_id}}::bigint
        AND a.pricing = 'cost'
        -- only OUTSIDE-customer sales are receivables; personal at-cost
        -- stock (party beneficiary) settles against the party's payout,
        -- and stock-plan commits (linked rows) come out of net profit —
        -- nobody pays the group back for its own stock
        AND a.beneficiary = 'both'
        AND a.stock_plan_item_id IS NULL
        AND a.received_at IS NULL
      ORDER BY a.created_at DESC
    `,
  });
}

export default listAtCostReceivables;
