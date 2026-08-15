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
 *
 * Takes the per-order advisory lock (class 42001): comp value feeds due
 * (billed - comps - write-off), and the write-off cap must never be computed
 * while a comp is changing the same order's due.
 */
function setOrderItemComp() {
  return action('setOrderItemComp', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), prev AS (
        SELECT oi.id, oi.comp_qty
        FROM lck, order_items oi
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
      ), upd AS (
        UPDATE order_items oi SET
          comp_qty = ({{params.comp_qty}})::numeric,
          comp_reason = CASE WHEN ({{params.comp_qty}})::numeric > 0 THEN TRIM({{params.reason}}) ELSE NULL END
        FROM lck
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
          AND ({{params.comp_qty}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          -- cap at the EFFECTIVE quantity (edited/removed lines), so a
          -- stored comp can never exceed what the customer actually gets —
          -- a removed line only accepts 0 (clearing)
          AND ({{params.comp_qty}})::numeric <= (CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END)
          AND (({{params.comp_qty}})::numeric = 0 OR LENGTH(TRIM({{params.reason}})) > 0)
        RETURNING oi.id, oi.comp_qty, oi.qty
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', upd.id::text, 'comp_set', {{params.actor}},
               jsonb_build_object('order_id', {{params.order_id}}::bigint, 'comp_qty', upd.comp_qty, 'line_qty', upd.qty, 'reason', {{params.reason}})
        FROM upd
        RETURNING row_pk
      ), wo_clear AS (
        -- a CHANGED comp moves due: a standing write-off was computed against
        -- the old due — auto-clear it, audited. Unchanged comp (same value
        -- re-saved) leaves the write-off alone.
        DELETE FROM order_writeoffs w
        USING upd, prev
        WHERE w.order_id = {{params.order_id}}::bigint
          AND prev.id = upd.id
          AND prev.comp_qty IS DISTINCT FROM upd.comp_qty
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'comp_change')
        FROM wo_clear
        RETURNING row_pk
      )
      SELECT id, comp_qty FROM upd
    `,
  });
}

export default setOrderItemComp;
