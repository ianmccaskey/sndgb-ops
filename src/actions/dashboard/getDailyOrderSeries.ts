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
      WITH daily AS (
        -- billed comes from the recon view (total + local items + fee-edit
        -- deltas) so the chart agrees with every other billed figure;
        -- adjustments attribute to the order's placement day
        SELECT o.placed_at::date AS day,
               COUNT(*) AS orders,
               ROUND(SUM(r.billed_usd), 2) AS billed_usd
        FROM orders o
        JOIN v_order_reconciliation r ON r.order_id = o.id
        WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
          AND o.status NOT IN ('cancelled','refunded')
          AND o.placed_at IS NOT NULL
        GROUP BY o.placed_at::date
      ), span AS (
        SELECT MIN(day) AS lo, MAX(day) AS hi FROM daily
      )
      -- Fill zero-order days so lulls render as gaps, not compressed away
      SELECT gs.day::date AS day,
             COALESCE(d.orders, 0) AS orders,
             COALESCE(d.billed_usd, 0) AS billed_usd
      FROM span, generate_series(span.lo, span.hi, interval '1 day') AS gs(day)
      LEFT JOIN daily d ON d.day = gs.day::date
      ORDER BY day
    `,
  });
}

export default getDailyOrderSeries;
