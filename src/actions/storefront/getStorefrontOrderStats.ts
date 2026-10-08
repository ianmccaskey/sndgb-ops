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
        -- "imported" means OUR copy of THIS storefront order — matched on the
        -- storefront id it was imported with, not just a number that happens
        -- to coincide with an ordering-app order
        count(*) FILTER (WHERE o.status <> 'cancelled'
                           AND NOT EXISTS (SELECT 1 FROM orders lo
                                           WHERE lo.group_buy_id = o.group_buy_id
                                             AND lo.raw_import->>'source' = 'storefront'
                                             AND lo.raw_import->>'storefront_order_id' = o.id::text)) AS not_imported,
        count(*) FILTER (WHERE o.status <> 'cancelled'
                           AND EXISTS (SELECT 1 FROM orders lo
                                       WHERE lo.order_number = o.order_number AND lo.group_buy_id = o.group_buy_id
                                         AND COALESCE(lo.raw_import->>'source', '') <> 'storefront')) AS number_collisions,
        max(o.placed_at) AS last_placed_at
      FROM storefront.orders o
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
    `,
  });
}

export default getStorefrontOrderStats;
