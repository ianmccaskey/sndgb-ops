import { action } from '@uibakery/data';

/**
 * Remove a mistaken refund record (the money side is Ian's to reverse — this
 * only fixes the books). Received rises with the removal; 42001 lock,
 * active-order guard, write-off auto-clear, audited with the full row.
 */
function deleteOrderRefund() {
  return action('deleteOrderRefund', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), del AS (
        DELETE FROM order_refunds orf
        USING lck, orders o
        WHERE orf.id = {{params.refund_id}}::bigint
          AND orf.order_id = {{params.order_id}}::bigint
          AND o.id = orf.order_id
          AND o.status NOT IN ('cancelled', 'refunded')
        RETURNING orf.id, orf.order_id, orf.amount_usd, orf.method, orf.wallet_id, orf.tx_ref, orf.reason
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING del
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'refund_removed')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_refunds', del.id::text, 'order_refund_removed', {{params.actor}},
             jsonb_build_object('order_id', del.order_id, 'amount_usd', del.amount_usd,
                                'method', del.method, 'wallet_id', del.wallet_id,
                                'tx_ref', del.tx_ref, 'reason', del.reason)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteOrderRefund;
