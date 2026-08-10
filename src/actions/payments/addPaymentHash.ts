import { action } from '@uibakery/data';

/**
 * Attach a transaction hash to an order as a new PENDING payment (it earns
 * 'verified' through the normal on-chain check, never by assertion). Hashes
 * are globally unique — inserting one that exists anywhere returns
 * inserted = 0 so the UI can say so instead of silently doing nothing.
 */
function addPaymentHash() {
  return action('addPaymentHash', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO payments (order_id, method, tx_hash, status)
        SELECT {{params.order_id}}::bigint, {{params.method}}::payment_method, TRIM({{params.tx_hash}}), 'pending'
        WHERE TRIM({{params.tx_hash}}) <> ''
          AND NOT EXISTS (SELECT 1 FROM payments WHERE tx_hash = TRIM({{params.tx_hash}}))
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
