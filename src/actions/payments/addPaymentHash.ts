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
      WITH input AS (
        SELECT CASE WHEN TRIM({{params.tx_hash}}) ~ '^0x[0-9a-fA-F]{64}$'
                    THEN lower(TRIM({{params.tx_hash}}))
                    ELSE TRIM({{params.tx_hash}}) END AS h
      ), ins AS (
        INSERT INTO payments (order_id, method, tx_hash, status)
        SELECT {{params.order_id}}::bigint, {{params.method}}::payment_method, input.h, 'pending'
        FROM input
        WHERE input.h <> ''
          AND NOT EXISTS (
            SELECT 1 FROM payments p
            WHERE (CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END) = input.h
              AND p.status <> 'rejected'
          )
        RETURNING id, order_id, method
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', ins.id::text, 'payment_hash_added', {{params.actor}},
               jsonb_build_object('order_id', ins.order_id, 'method', ins.method, 'tx_hash', (SELECT h FROM input))
        FROM ins
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM ins) AS inserted
    `,
  });
}

export default addPaymentHash;
