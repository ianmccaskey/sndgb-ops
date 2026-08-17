import { action } from '@uibakery/data';

/**
 * Stamp a planned allocation as ORDERED — called by the UI only AFTER the
 * real vendor payment recorded successfully through addVendorPayment (the
 * guarded money path). Snapshots the paid total; one-way (zero rows if
 * already ordered). Audited.
 */
function markStockPlanItemOrdered() {
  return action('markStockPlanItemOrdered', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE stock_plan_items
        SET ordered_at = now(), ordered_by = {{params.actor}},
            ordered_value_usd = ({{params.ordered_value_usd}})::numeric
        WHERE id = {{params.item_id}}::bigint
          AND ordered_at IS NULL
          AND ({{params.ordered_value_usd}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
        RETURNING id, group_buy_product_id, kits, ordered_value_usd
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'stock_plan_items', up.id::text, 'stock_plan_item_ordered', {{params.actor}},
             jsonb_build_object('group_buy_product_id', up.group_buy_product_id,
                                'kits', up.kits, 'ordered_value_usd', up.ordered_value_usd)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default markStockPlanItemOrdered;
