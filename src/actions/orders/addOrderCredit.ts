import { action } from '@uibakery/data';

/**
 * Credit a customer's order — a deliberate price reduction agreed with the
 * customer (goodwill, negotiated adjustment, correction settlement). Reduces
 * due (billed − comps − CREDITS − write-off) and books as a revenue
 * deduction in P&L like a comp. Unlike a write-off it is independent of
 * payment state: it applies before payments and never auto-clears.
 *
 * Guards (zero rows = refused): active order; amount positive with max 2
 * decimals, string-checked; a non-empty reason (credits are audited money).
 * Takes the 42001 per-order lock (due moves) and auto-clears a standing
 * write-off — it was computed against the old due.
 */
function addOrderCredit() {
  return action('addOrderCredit', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), cap AS (
        -- a credit can never push due negative: an oversized credit would
        -- manufacture synthetic overpay the refund path could then accept.
        -- Read under the lock — every due writer serializes on 42001.
        SELECT GREATEST(r.due_usd, 0) AS max_credit
        FROM lck, v_order_reconciliation r
        WHERE r.order_id = {{params.order_id}}::bigint
      ), ins AS (
        INSERT INTO order_credits (order_id, amount_usd, reason, created_by)
        SELECT o.id, {{params.amount_usd}}::numeric, TRIM({{params.reason}}), {{params.actor}}
        FROM cap, orders o
        WHERE o.id = {{params.order_id}}::bigint
          AND o.status NOT IN ('cancelled', 'refunded')
          AND ({{params.amount_usd}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.amount_usd}})::numeric > 0
          AND ({{params.amount_usd}})::numeric <= cap.max_credit
          AND LENGTH(TRIM({{params.reason}})) > 0
        RETURNING id, order_id, amount_usd, reason
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING ins
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'credit_added')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_credits', ins.id::text, 'order_credit_added', {{params.actor}},
             jsonb_build_object('order_id', ins.order_id, 'amount_usd', ins.amount_usd, 'reason', ins.reason,
                                'max_credit_at_insert', (SELECT max_credit FROM cap))
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addOrderCredit;
