import { action } from '@uibakery/data';

/**
 * Add an item to an order LOCALLY — for when the ordering app can't take the
 * change (ordering closed) but this app, which fulfillment runs from, must
 * record what the customer is actually getting. The row is item_source
 * 'local': imports never prune or qty-reset it, and reconciliation bills the
 * order total_usd + local items value so the extra payment is EXPECTED. If
 * the same SKU is later added upstream, the next pull adopts the row.
 *
 * Guards (zero rows = refused):
 *  - the SKU must be a campaign product (price comes from its GB price);
 *  - qty positive, max 2 decimals, checked on the string like every other
 *    quantity boundary;
 *  - the order must not already have that product — one row per product is
 *    a schema invariant, and silently converting an imported line to local
 *    would fork it from upstream; top-ups belong in the ordering app.
 *
 * Takes the 42001 per-order lock: this changes due, so it serializes with
 * write-off caps like every other due writer, and a standing write-off is
 * auto-cleared (audited) — it was computed against the old due.
 */
function addLocalOrderItem() {
  return action('addLocalOrderItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), ins AS (
        INSERT INTO order_items (order_id, group_buy_product_id, qty, unit_price_usd, item_source)
        SELECT o.id, gbp.id, {{params.qty}}::numeric, gbp.gb_price_usd, 'local'
        FROM products p
        JOIN group_buy_products gbp ON gbp.product_id = p.id
          AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
          -- a cancelled campaign product must not gain new billable demand
          AND gbp.status = 'active'
        -- the ORDER must live in the same campaign as the product — a stale
        -- or mismatched call must never attach campaign B's product (and
        -- price) to campaign A's order
        JOIN orders o ON o.id = {{params.order_id}}::bigint
          AND o.group_buy_id = gbp.group_buy_id
          -- financially active orders only: recon hides cancelled/refunded
          -- orders, so a local item here would be dormant billing that
          -- silently reappears if the status ever flips back
          AND o.status NOT IN ('cancelled', 'refunded')
        WHERE p.sku_code = {{params.sku}}::text
          -- the order must still be in the pack flow: once its latest
          -- shipment is packed/shipped, a new item would bill the customer
          -- for something fulfillment never sees — reopen the shipment
          -- (set it back to pending) first, then add
          AND COALESCE((
            SELECT sh.status::text FROM shipments sh
            WHERE sh.order_id = o.id
            ORDER BY sh.created_at DESC LIMIT 1
          ), 'pending') = 'pending'
          AND ({{params.qty}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.qty}})::numeric > 0
          -- whole kits only: a fractional local line would owe the split
          -- fee, which is charged by the ordering app — local billing has
          -- no fee term, so a local half kit would bill wrong
          AND ({{params.qty}})::numeric % 1 = 0
          AND (SELECT COUNT(*) FROM lck) >= 0
          AND NOT EXISTS (
            SELECT 1 FROM order_items oi
            WHERE oi.order_id = {{params.order_id}}::bigint
              AND oi.group_buy_product_id = gbp.id
          )
        RETURNING id, group_buy_product_id, qty, unit_price_usd
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING ins
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}}::text,
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'local_item_added')
        FROM wo_clear
        RETURNING row_pk
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', ins.id::text, 'local_item_added', {{params.actor}}::text,
               jsonb_build_object('order_id', {{params.order_id}}::bigint, 'sku', {{params.sku}}::text,
                                  'qty', ins.qty, 'unit_price_usd', ins.unit_price_usd,
                                  'value_usd', ins.qty * ins.unit_price_usd)
        FROM ins
        RETURNING row_pk
      )
      SELECT id FROM ins
    `,
  });
}

export default addLocalOrderItem;
