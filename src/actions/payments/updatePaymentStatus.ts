import { action } from '@uibakery/data';

/**
 * Manual status change with an optimistic-concurrency guard: when
 * expected_status is provided, the write only lands if the row still has
 * that status — a stale UI action (e.g. rejecting a payment the verifier
 * just marked verified) returns zero rows instead of clobbering it.
 *
 * Takes the per-order advisory lock (class 42001) shared by every
 * reconciliation-affecting write: this action CAN set 'verified' with an
 * amount, and a write-off's shortfall cap must never be computed while
 * money is landing on the same order.
 */
function updatePaymentStatus() {
  return action('updatePaymentStatus', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, p.order_id::int) AS locked
        FROM payments p
        WHERE p.id = {{params.payment_id}}::bigint
      ), upd AS (
        UPDATE payments SET
          status = {{params.status}}::payment_status,
          amount_usd = {{params.amount_usd}}::numeric,
          verify_source = 'manual',
          verified_at = CASE WHEN {{params.status}}::text = 'verified' THEN now() ELSE verified_at END,
          notes = NULLIF({{params.notes}}::text, '')
        FROM lck
        WHERE id = {{params.payment_id}}::bigint
          AND (COALESCE({{params.expected_status}}, '') = '' OR status = {{params.expected_status}}::payment_status)
        RETURNING id, order_id, amount_usd, status
      ), wo_clear AS (
        -- a manual flip to 'verified' lands money: auto-clear any standing
        -- write-off (audited) so P&L can't keep deducting collected revenue
        DELETE FROM order_writeoffs w
        USING upd
        WHERE w.order_id = upd.order_id
          AND upd.status = 'verified'
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'manual_status_change')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'payments', upd.id::text, 'manual_status_change', {{params.actor}},
             jsonb_build_object('order_id', upd.order_id, 'amount_usd', upd.amount_usd, 'status', upd.status)
      FROM upd
      RETURNING row_pk AS id
    `,
  });
}

export default updatePaymentStatus;
