import { action } from '@uibakery/data';

/**
 * Set (or clear, with amount 0) the write-off on an order — forgiving a
 * small residual shortfall so recon reads matched while the forgiven value
 * stays on the books (due = billed - comps - write-off; P&L deducts it).
 *
 * One statement, all audited. Guards (violations = no rows written):
 *  - amount is a valid 2-decimal value; > 0 to set, exactly 0 to clear;
 *  - a non-empty reason is REQUIRED to set (write-offs are audited money);
 *  - the amount may not exceed the order's CURRENT residual shortfall
 *    (diff + any existing write-off, computed in-transaction from the recon
 *    view) — a write-off can forgive what's missing, never more, so it can't
 *    be used to hide an overpayment or double-forgive after money arrives;
 *  - the order must have NO pending payments: a hash awaiting verification
 *    may still turn into money, and nothing auto-clears a write-off when it
 *    does — verify or reject the pending payment first, then write off what
 *    is genuinely missing.
 * Setting replaces the existing write-off (one active per order, UNIQUE).
 *
 * Concurrency: the cap read and the write must not race a payment landing
 * for the same order. All reconciliation-increasing writes (chain verify,
 * manual payment, override) and this action take the same per-order advisory
 * lock (class 42001, transaction-scoped), so the cap is computed against a
 * serialized view of the order's money.
 */
function setOrderWriteoff() {
  return action('setOrderWriteoff', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), cap AS (
        SELECT r.diff_usd + COALESCE(w.amount_usd, 0) AS max_writeoff,
               r.pending_payment_count
        FROM lck, v_order_reconciliation r
        LEFT JOIN order_writeoffs w ON w.order_id = r.order_id
        WHERE r.order_id = {{params.order_id}}::bigint
      ), del AS (
        DELETE FROM order_writeoffs w
        USING lck
        WHERE w.order_id = {{params.order_id}}::bigint
          AND ({{params.amount}})::text ~ '^0+(\\.0{1,2})?$'
        RETURNING w.id, w.amount_usd
      ), ins AS (
        INSERT INTO order_writeoffs (order_id, amount_usd, reason, created_by)
        SELECT {{params.order_id}}::bigint, ({{params.amount}})::numeric, TRIM({{params.reason}}), {{params.actor}}
        FROM cap
        WHERE ({{params.amount}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.amount}})::numeric > 0
          AND LENGTH(TRIM({{params.reason}})) > 0
          AND ({{params.amount}})::numeric <= cap.max_writeoff
          AND cap.pending_payment_count = 0
        ON CONFLICT (order_id) DO UPDATE SET
          amount_usd = EXCLUDED.amount_usd,
          reason = EXCLUDED.reason,
          created_by = EXCLUDED.created_by,
          updated_at = now()
        RETURNING id, amount_usd
      ), audit_set AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', ins.id::text, 'writeoff_set', {{params.actor}},
               jsonb_build_object('order_id', {{params.order_id}}::bigint, 'amount_usd', ins.amount_usd, 'reason', TRIM({{params.reason}}))
        FROM ins
        RETURNING row_pk
      ), audit_clear AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', del.id::text, 'writeoff_cleared', {{params.actor}},
               jsonb_build_object('order_id', {{params.order_id}}::bigint, 'old_amount_usd', del.amount_usd)
        FROM del
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM ins) + (SELECT COUNT(*) FROM del) AS written
    `,
  });
}

export default setOrderWriteoff;
