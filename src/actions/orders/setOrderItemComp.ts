import { action } from '@uibakery/data';

/**
 * Mark some (or all, or none again) of an order line as comped — free product
 * given to the customer. Update + audit are one statement. Refused (no rows)
 * unless every guard holds:
 *  - comp_qty is a valid NUMERIC(10,2) value (max 2 decimals, string-checked
 *    like every other quantity boundary — Postgres must never silently round);
 *  - comp_qty <= the line's qty (can't comp more than they ordered);
 *  - a non-empty reason accompanies any comp > 0 (comps are audited money);
 *    setting comp_qty back to 0 clears the comp and needs no reason.
 */
function setOrderItemComp() {
  return action('setOrderItemComp', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE order_items oi SET
          comp_qty = ({{params.comp_qty}})::numeric,
          comp_reason = CASE WHEN ({{params.comp_qty}})::numeric > 0 THEN TRIM({{params.reason}}) ELSE NULL END
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
          AND ({{params.comp_qty}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.comp_qty}})::numeric <= oi.qty
          AND (({{params.comp_qty}})::numeric = 0 OR LENGTH(TRIM({{params.reason}})) > 0)
        RETURNING oi.id, oi.comp_qty, oi.qty
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', upd.id::text, 'comp_set', {{params.actor}},
               jsonb_build_object('order_id', {{params.order_id}}::bigint, 'comp_qty', upd.comp_qty, 'line_qty', upd.qty, 'reason', {{params.reason}})
        FROM upd
        RETURNING row_pk
      )
      SELECT id, comp_qty FROM upd
    `,
  });
}

export default setOrderItemComp;
