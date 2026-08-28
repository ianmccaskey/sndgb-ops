import { action } from '@uibakery/data';

/**
 * Remove a planned allocation. An ORDERED line is refused (zero rows) —
 * the vendor payment it produced is real money, and the plan line is its
 * provenance. A COMMITTED line (linked stock-plan adjustment) is refused
 * too: the adjustment carries the vendor demand and the net-profit
 * deduction, so the recovery path is removing the adjustment on the
 * Products page (which frees this line again). Campaign-scoped like
 * every destructive action: a stale or cross-campaign id must not touch
 * another campaign's plan. Audited.
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
          AND NOT EXISTS (SELECT 1 FROM admin_adjustments a WHERE a.stock_plan_item_id = i.id)
        RETURNING i.id, i.group_buy_product_id, i.kits
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'stock_plan_items', del.id::text, 'stock_plan_item_deleted', {{params.actor}}::text,
             jsonb_build_object('group_buy_product_id', del.group_buy_product_id, 'kits', del.kits)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteStockPlanItem;
