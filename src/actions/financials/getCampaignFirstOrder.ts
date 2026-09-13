import { action } from '@uibakery/data';

/**
 * The campaign's true start for money purposes: the moment its FIRST
 * order was placed in the ordering app (placed_at survives import).
 * The local campaign row is often scaffolded days later, so its
 * created/starts_on dates are useless as a wallet baseline — but no
 * customer payment can predate its order, so balance-at-this-instant
 * is a clean "before this buy" number.
 */
function getCampaignFirstOrder() {
  return action('getCampaignFirstOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT MIN(placed_at) AS first_order_at, COUNT(*) AS order_count
      FROM orders
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
    `,
  });
}

export default getCampaignFirstOrder;
