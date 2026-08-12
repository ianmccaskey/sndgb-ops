import { action } from '@uibakery/data';

/**
 * Upsert ONE order line item, keyed on (order_id, group_buy_product_id).
 * Single-row on purpose: UI Bakery's action layer rejects multi-row inserts
 * whose key columns repeat ("order_id must be unique"), which is what broke
 * the old replaceOrderItems. Returns no rows when the SKU doesn't match a
 * campaign product — the caller counts successes against the source list.
 *
 * qty is validated here too, not just in the parsers: the column is
 * NUMERIC(10,2) and Postgres would silently round finer fractions on insert,
 * so this last write boundary refuses (returns no rows) any qty that isn't
 * a positive value with at most two decimals.
 *
 * comp_qty (comped/free units, set by setOrderItemComp) is PERSISTENTLY
 * clamped to the incoming qty on update, with an audit row when that
 * changes it. Clamping only in the views would let an old larger comp
 * silently re-expand if upstream later raises the qty again — a revenue
 * write-off must never grow without a fresh operator decision.
 */
function upsertOrderItem() {
  return action('upsertOrderItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- per-order advisory lock (class 42001): item price/comp-clamp
        -- changes feed due (billed - comps - write-off), so they serialize
        -- with write-off cap reads like every other due/received writer
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), prev AS (
        -- FOR UPDATE: locks the existing row so a concurrent comp edit can't
        -- land between this snapshot and the conflict-update below — the
        -- clamp and its audit comparison must see the same old value.
        SELECT oi.id, oi.comp_qty, oi.unit_price_usd
        FROM order_items oi
        JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
        JOIN products p ON p.id = gbp.product_id AND p.sku_code = {{params.sku}}
        WHERE oi.order_id = {{params.order_id}}::bigint
          AND (SELECT COUNT(*) FROM lck) >= 0
        FOR UPDATE OF oi
      ), ins AS (
        INSERT INTO order_items (order_id, group_buy_product_id, qty, unit_price_usd)
        SELECT {{params.order_id}}::bigint, gbp.id, {{params.qty}}::numeric, gbp.gb_price_usd
        FROM products p
        JOIN group_buy_products gbp ON gbp.product_id = p.id
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
        WHERE p.sku_code = {{params.sku}}
          AND ({{params.qty}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.qty}})::numeric > 0
          AND (SELECT COUNT(*) FROM lck) >= 0
        ON CONFLICT (order_id, group_buy_product_id) DO UPDATE SET
          qty = EXCLUDED.qty,
          unit_price_usd = EXCLUDED.unit_price_usd,
          comp_qty = LEAST(order_items.comp_qty, EXCLUDED.qty)
        RETURNING id, comp_qty, unit_price_usd
      ), wo_clear AS (
        -- comp-value inputs changed (clamped comp or repriced line) — due
        -- moved, so a standing write-off no longer describes reality:
        -- auto-clear it, audited. Unchanged rows and new items don't touch it.
        DELETE FROM order_writeoffs w
        USING ins, prev
        WHERE w.order_id = {{params.order_id}}::bigint
          AND prev.id = ins.id
          AND (prev.comp_qty IS DISTINCT FROM ins.comp_qty
               OR prev.unit_price_usd IS DISTINCT FROM ins.unit_price_usd)
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'item_change')
        FROM wo_clear
        RETURNING row_pk
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', ins.id::text, 'comp_clamped_on_import', {{params.actor}},
               jsonb_build_object('old_comp_qty', prev.comp_qty, 'new_comp_qty', ins.comp_qty, 'imported_qty', ({{params.qty}})::numeric)
        FROM ins
        JOIN prev ON prev.id = ins.id
        WHERE ins.comp_qty < prev.comp_qty
        RETURNING row_pk
      )
      SELECT id FROM ins
    `,
  });
}

export default upsertOrderItem;
