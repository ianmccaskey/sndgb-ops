import { action } from '@uibakery/data';

/**
 * Remove (or restore) an IMPORTED order line locally while the ordering app
 * still carries it. Marks removed_at rather than deleting: pulls keep
 * refreshing the base row, the effective quantity is 0 everywhere (billing,
 * demand, comps, fulfillment), and the row only truly deletes when a pull
 * sees upstream drop the product WITH the header total moving in the same
 * pull (importUpsertOrder's gated retirement — a partial push can never
 * silently misbill). Locally-added rows refuse here — they hard-delete via
 * deleteLocalOrderItem.
 *
 * Same pack-flow gate as every item mutation: refused once the latest
 * shipment left pending. 42001 lock + write-off auto-clear (due moves).
 */
function removeOrderItem() {
  return action('removeOrderItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), prev AS (
        SELECT oi.id, oi.removed_at, oi.comp_qty
        FROM lck, order_items oi
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
        FOR UPDATE OF oi
      ), upd AS (
        UPDATE order_items oi SET
          removed_at = CASE WHEN {{params.removed}}::boolean THEN now() ELSE NULL END,
          -- removing a comped line CLEARS the comp persistently: restoring
          -- the line later must not silently resurrect forgiven revenue —
          -- a comp is always a fresh audited decision
          comp_qty = CASE WHEN {{params.removed}}::boolean THEN 0 ELSE oi.comp_qty END,
          comp_reason = CASE WHEN {{params.removed}}::boolean THEN NULL ELSE oi.comp_reason END
        FROM lck, orders o
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
          AND o.id = oi.order_id
          AND o.status NOT IN ('cancelled', 'refunded')
          AND oi.item_source = 'import'
          AND (({{params.removed}}::boolean AND oi.removed_at IS NULL)
               OR (NOT {{params.removed}}::boolean AND oi.removed_at IS NOT NULL))
          -- never remove the LAST active line: an order with zero effective
          -- items is a cancellation, which has its own flow — this mirrors
          -- the push's full-wipe refusal
          AND (NOT {{params.removed}}::boolean OR EXISTS (
            SELECT 1 FROM order_items oj
            WHERE oj.order_id = oi.order_id AND oj.id <> oi.id AND oj.removed_at IS NULL
          ))
          -- a line with quantity attributed to any non-voided shipment
          -- (drafts reserve too) cannot vanish — the box physically exists
          -- or is being packed; void/refund that shipment first
          AND COALESCE((
            SELECT sum(si.qty) FROM shipment_items si
            JOIN shipments sh ON sh.id = si.shipment_id
            WHERE si.order_item_id = oi.id
              AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
          ), 0) = 0
        RETURNING oi.id, oi.qty, oi.qty_override, oi.removed_at, oi.comp_qty
      ), comp_clear_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', upd.id::text, 'comp_cleared_on_removal', {{params.actor}}::text,
               jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                  'old_comp_qty', prev.comp_qty)
        FROM upd
        JOIN prev ON prev.id = upd.id
        WHERE {{params.removed}}::boolean AND prev.comp_qty > 0
        RETURNING row_pk
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING upd
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}}::text,
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'item_removed_change')
        FROM wo_clear
        RETURNING row_pk
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', upd.id::text,
               CASE WHEN {{params.removed}}::boolean THEN 'item_removed_locally' ELSE 'item_removal_undone' END,
               {{params.actor}}::text,
               jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                  'imported_qty', upd.qty, 'qty_override', upd.qty_override)
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default removeOrderItem;
