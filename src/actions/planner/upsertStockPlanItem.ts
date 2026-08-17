import { action } from '@uibakery/data';

/**
 * Add or re-quantify a planned allocation (one row per product). Creates
 * the plan header lazily. Guards (zero rows = refused): whole positive
 * kits (string-scale checked); the product belongs to THIS campaign, is
 * active, and is flat-cost (tiered per-kit cost is ambiguous — same rule
 * as at-cost adjustments); an ORDERED line cannot be re-quantified (the
 * recorded vendor payment is the truth of what was bought). Audited.
 */
function upsertStockPlanItem() {
  return action('upsertStockPlanItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH plan AS (
        INSERT INTO stock_plans (group_buy_id, updated_by)
        VALUES ({{params.group_buy_id}}::bigint, {{params.actor}})
        ON CONFLICT (group_buy_id) DO UPDATE SET updated_at = now()
        RETURNING id
      ), up AS (
        INSERT INTO stock_plan_items (plan_id, group_buy_product_id, kits, created_by)
        SELECT plan.id, gbp.id, ({{params.kits}})::numeric, {{params.actor}}
        FROM plan
        JOIN group_buy_products gbp ON gbp.id = {{params.group_buy_product_id}}::bigint
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
          AND gbp.status = 'active'
          AND gbp.cost_tier_qty IS NULL
        WHERE ({{params.kits}})::text ~ '^[0-9]+$'
          AND ({{params.kits}})::numeric > 0
        ON CONFLICT (plan_id, group_buy_product_id) DO UPDATE SET
          kits = EXCLUDED.kits
        WHERE stock_plan_items.ordered_at IS NULL
        RETURNING id, group_buy_product_id, kits
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'stock_plan_items', up.id::text, 'stock_plan_item_set', {{params.actor}},
             jsonb_build_object('group_buy_product_id', up.group_buy_product_id, 'kits', up.kits)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default upsertStockPlanItem;
