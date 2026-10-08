import { action } from '@uibakery/data';

/** Storefront order counts by status for a campaign, plus how many are not yet imported here. */
function getStorefrontOrderStats() {
  return action('getStorefrontOrderStats', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT
        count(*) FILTER (WHERE o.status = 'unpaid') AS unpaid,
        count(*) FILTER (WHERE o.status = 'payment_submitted') AS payment_submitted,
        count(*) FILTER (WHERE o.status = 'paid') AS paid,
        count(*) FILTER (WHERE o.status = 'cancelled') AS cancelled,
        count(*) FILTER (WHERE o.status <> 'cancelled'
                           AND NOT EXISTS (SELECT 1 FROM orders lo WHERE lo.order_number = o.order_number AND lo.group_buy_id = o.group_buy_id)) AS not_imported,
        max(o.placed_at) AS last_placed_at
      FROM storefront.orders o
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
    `,
  });
}

export default getStorefrontOrderStats;
