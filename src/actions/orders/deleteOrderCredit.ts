import { action } from '@uibakery/data';

/**
 * Remove a mistaken order credit. Due rises with the removal, so the 42001
 * lock is taken and a standing write-off auto-clears. Audited with the full
 * removed row; active orders only, same as every money mutation.
 */
function deleteOrderCredit() {
  return action('deleteOrderCredit', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), del AS (
        DELETE FROM order_credits oc
        USING lck, orders o
        WHERE oc.id = {{params.credit_id}}::bigint
          AND oc.order_id = {{params.order_id}}::bigint
          AND o.id = oc.order_id
          AND o.status NOT IN ('cancelled', 'refunded')
        RETURNING oc.id, oc.order_id, oc.amount_usd, oc.reason
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING del
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}}::text,
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'credit_removed')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_credits', del.id::text, 'order_credit_removed', {{params.actor}}::text,
             jsonb_build_object('order_id', del.order_id, 'amount_usd', del.amount_usd, 'reason', del.reason)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteOrderCredit;
