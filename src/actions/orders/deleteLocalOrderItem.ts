import { action } from '@uibakery/data';

/**
 * Remove a LOCALLY added order item (the undo for addLocalOrderItem).
 * Imported rows refuse — upstream items leave via the ordering app + pull,
 * never by local deletion. Due drops with the item, so the 42001 lock is
 * taken and any standing write-off auto-clears (audited).
 */
function deleteLocalOrderItem() {
  return action('deleteLocalOrderItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), del AS (
        DELETE FROM order_items oi
        USING lck, orders o
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
          AND o.id = oi.order_id
          -- same active-order guard as every item mutation: dormant billing
          -- on a hidden (cancelled/refunded) order must not change silently
          AND o.status NOT IN ('cancelled', 'refunded')
          AND oi.item_source = 'local'
          -- never delete the LAST active line (another line may be locally
          -- removed and not count): a zero-item order is a cancellation,
          -- same invariant as removeOrderItem
          AND EXISTS (
            SELECT 1 FROM order_items oj
            WHERE oj.order_id = oi.order_id AND oj.id <> oi.id AND oj.removed_at IS NULL
          )
          -- same pack-flow gate as the add path, in reverse: once the order
          -- packed/shipped, removing an item would drop billed/due while the
          -- box may already contain it — reopen the shipment first
          AND COALESCE((
            SELECT sh.status::text FROM shipments sh
            WHERE sh.order_id = oi.order_id
            ORDER BY sh.created_at DESC LIMIT 1
          ), 'pending') = 'pending'
        RETURNING oi.id, oi.group_buy_product_id, oi.qty, oi.unit_price_usd
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING del
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'local_item_removed')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_items', del.id::text, 'local_item_removed', {{params.actor}},
             jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                'group_buy_product_id', del.group_buy_product_id,
                                'qty', del.qty, 'unit_price_usd', del.unit_price_usd)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteLocalOrderItem;
