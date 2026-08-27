import { action } from '@uibakery/data';

/**
 * Attach a transaction hash to an order as a new PENDING payment (it earns
 * 'verified' through the normal on-chain check, never by assertion). Refused
 * (inserted = 0) when the canonical hash exists on any NON-REJECTED payment,
 * or on THIS order in any status — re-adding a hash rejected on the same
 * order would defeat the audited rejection. A hash rejected on a DIFFERENT
 * order may be attached — that's the wrong-order correction: reject it
 * there, add it here.
 */
function addPaymentHash() {
  return action('addPaymentHash', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- per-order advisory lock (class 42001): creating PENDING payments
        -- must serialize with the write-off guard (refuses positive
        -- write-offs while any payment is pending)
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), input AS (
        SELECT CASE WHEN TRIM({{params.tx_hash}}::text) ~ '^0x[0-9a-fA-F]{64}$'
                    THEN lower(TRIM({{params.tx_hash}}::text))
                    ELSE TRIM({{params.tx_hash}}::text) END AS h
      ), ins AS (
        INSERT INTO payments (order_id, method, tx_hash, status)
        SELECT {{params.order_id}}::bigint, {{params.method}}::payment_method, input.h, 'pending'
        FROM input, lck
        WHERE input.h <> ''
          AND NOT EXISTS (
            SELECT 1 FROM payments p
            WHERE (CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END) = input.h
              AND (p.status <> 'rejected' OR p.order_id = {{params.order_id}}::bigint)
          )
        RETURNING id, order_id, method
      ), wo_clear AS (
        -- new incoming payment evidence: a standing write-off must not keep
        -- the order reading matched while this pends — auto-clear, audited;
        -- if the payment fails verification the order shows short again
        DELETE FROM order_writeoffs w
        USING ins
        WHERE w.order_id = ins.order_id
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'hash_added')
        FROM wo_clear
        RETURNING row_pk
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
