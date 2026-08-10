import { action } from '@uibakery/data';

/**
 * Attach a transaction hash to an order as a new PENDING payment (it earns
 * 'verified' through the normal on-chain check, never by assertion). A hash
 * on any NON-REJECTED payment is refused (inserted = 0); a hash that exists
 * only as rejected may be re-attached — that's the wrong-order correction:
 * reject it there, add it here.
 */
function addPaymentHash() {
  return action('addPaymentHash', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO payments (order_id, method, tx_hash, status)
        SELECT {{params.order_id}}::bigint, {{params.method}}::payment_method, TRIM({{params.tx_hash}}), 'pending'
        WHERE TRIM({{params.tx_hash}}) <> ''
          AND NOT EXISTS (SELECT 1 FROM payments WHERE tx_hash = TRIM({{params.tx_hash}}) AND status <> 'rejected')
        RETURNING id, order_id, method
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', ins.id::text, 'payment_hash_added', {{params.actor}},
               jsonb_build_object('order_id', ins.order_id, 'method', ins.method, 'tx_hash', TRIM({{params.tx_hash}}))
        FROM ins
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM ins) AS inserted
    `,
  });
}

export default addPaymentHash;
