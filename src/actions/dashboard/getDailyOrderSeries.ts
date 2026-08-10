import { action } from '@uibakery/data';

/**
 * Daily order counts and billed dollars across the campaign window, for the
 * dashboard momentum charts. Cancelled/refunded orders are excluded (same
 * rule as every revenue number); orders without a placed_at are skipped —
 * they can't be placed on a timeline.
 */
function getDailyOrderSeries() {
  return action('getDailyOrderSeries', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT placed_at::date AS day,
             COUNT(*) AS orders,
             ROUND(SUM(total_usd), 2) AS billed_usd
      FROM orders
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
        AND status NOT IN ('cancelled','refunded')
        AND placed_at IS NOT NULL
      GROUP BY placed_at::date
      ORDER BY day
    `,
  });
}

export default getDailyOrderSeries;
