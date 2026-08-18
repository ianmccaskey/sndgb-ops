import { action } from '@uibakery/data';

/**
 * The campaign's stock plan: one header row (source figures, LEFT-joined so
 * an unsaved plan returns a defaults row) plus its allocation items joined
 * to live product economics — planned value is ALWAYS computed live as
 * kits x (unit_cost + freight); a committed item carries ordered_value_usd
 * (what was actually paid) alongside.
 */
function getStockPlan() {
  return action('getStockPlan', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT
        COALESCE(sp.outside_total_usd, 0) AS outside_total_usd,
        COALESCE(sp.outside_max_usd, 0) AS outside_max_usd,
        COALESCE(sp.cash_assignable_usd, 0) AS cash_assignable_usd,
        sp.updated_by, sp.updated_at,
        COALESCE(items.items, '[]'::jsonb) AS items
      FROM group_buys gb
      LEFT JOIN stock_plans sp ON sp.group_buy_id = gb.id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'id', i.id,
                 'group_buy_product_id', i.group_buy_product_id,
                 'sku_code', p.sku_code,
                 'vendor_code', v.code,
                 'kits', i.kits,
                 'unit_cost_usd', gbp.unit_cost_usd,
                 'freight_usd', gbp.freight_usd,
                 'planned_value_usd', ROUND(i.kits * (gbp.unit_cost_usd + gbp.freight_usd), 2),
                 'ordered_at', i.ordered_at,
                 'ordered_by', i.ordered_by,
                 'ordered_value_usd', i.ordered_value_usd,
                 'committed_adjustment_id', ca.id,
                 'committed_at', ca.created_at,
                 'committed_value_usd', ca.expected_usd
               ) ORDER BY p.sku_code) AS items
        FROM stock_plan_items i
        JOIN group_buy_products gbp ON gbp.id = i.group_buy_product_id
        JOIN products p ON p.id = gbp.product_id
        JOIN vendors v ON v.id = gbp.vendor_id
        -- a COMMITTED line's adjustment carries its vendor demand and the
        -- net-profit deduction (snapshot at commit time)
        LEFT JOIN admin_adjustments ca ON ca.stock_plan_item_id = i.id
        WHERE i.plan_id = sp.id
      ) items ON sp.id IS NOT NULL
      WHERE gb.id = {{params.group_buy_id}}::bigint
    `,
  });
}

export default getStockPlan;
