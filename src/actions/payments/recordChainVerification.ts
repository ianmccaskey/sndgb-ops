import { action } from '@uibakery/data';

/**
 * Writes the result of an on-chain lookup (Moralis/Helius) onto a payment:
 * the observed USD amount, any native-token details, and verified/mismatch.
 * Only PENDING rows are written — a payment rejected (or otherwise resolved)
 * between the lookup starting and finishing must not be overwritten by the
 * stale result. Zero rows returned = the row was no longer pending.
 *
 * Takes the per-order advisory lock (class 42001) shared with write-offs,
 * manual payments, and overrides: a write-off's shortfall cap must never be
 * computed while this verification is landing money on the same order.
 */
function recordChainVerification() {
  return action('recordChainVerification', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, p.order_id::int) AS locked
        FROM payments p
        WHERE p.id = {{params.payment_id}}::bigint
      ), upd AS (
        UPDATE payments SET
          amount_usd = {{params.amount_usd}}::numeric,
          native_amount = NULLIF({{params.native_amount}}::text, '')::numeric,
          native_symbol = NULLIF({{params.native_symbol}}::text, ''),
          value_at_pay_usd = NULLIF({{params.value_at_pay_usd}}::text, '')::numeric,
          status = {{params.status}}::payment_status,
          verify_source = 'auto',
          verified_at = now(),
          notes = NULLIF({{params.notes}}::text, '')
        FROM lck
        WHERE id = {{params.payment_id}}::bigint
          AND status = 'pending'
        RETURNING id, order_id, amount_usd, status
      ), wo_clear AS (
        -- money (or a real-but-unpriced native tx) just landed: a standing
        -- write-off no longer describes reality — auto-clear it, audited.
        -- Data-modifying CTEs run even when unreferenced by the final query.
        DELETE FROM order_writeoffs w
        USING upd
        WHERE w.order_id = upd.order_id
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'chain_verify')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'payments', upd.id::text, 'chain_verify', {{params.actor}},
             jsonb_build_object('order_id', upd.order_id, 'amount_usd', upd.amount_usd, 'status', upd.status)
      FROM upd
      RETURNING row_pk AS id
    `,
  });
}

export default recordChainVerification;
