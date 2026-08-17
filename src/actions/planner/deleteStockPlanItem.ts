import { action } from '@uibakery/data';

/**
 * Remove a planned allocation. An ORDERED line is refused (zero rows) —
 * the vendor payment it produced is real money, and the plan line is its
 * provenance. Campaign-scoped like every destructive action: a stale or
 * cross-campaign id must not touch another campaign's plan. Audited.
 */
function deleteStockPlanItem() {
  return action('deleteStockPlanItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH del AS (
        DELETE FROM stock_plan_items i
        USING stock_plans sp
        WHERE i.id = {{params.item_id}}::bigint
          AND sp.id = i.plan_id
          AND sp.group_buy_id = {{params.group_buy_id}}::bigint
          AND i.ordered_at IS NULL
        RETURNING i.id, i.group_buy_product_id, i.kits
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'stock_plan_items', del.id::text, 'stock_plan_item_deleted', {{params.actor}},
             jsonb_build_object('group_buy_product_id', del.group_buy_product_id, 'kits', del.kits)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteStockPlanItem;
