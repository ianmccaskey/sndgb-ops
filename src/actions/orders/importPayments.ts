import { action } from '@uibakery/data';

/**
 * Records imported payment references for an order from a JSON array of
 * {kind: 'tx_hash' | 'receipt', value, method}.
 * - a tx hash that exists on any NON-REJECTED payment is skipped (verified
 *   payments are never reset to pending), and a hash rejected on THIS order
 *   is never resurrected by a re-pull. A hash rejected on a DIFFERENT order
 *   may import here — same reassignment rule as the manual add path, so a
 *   wrong-order correction completes on the next pull.
 * - pending receipt refs (no hash) are replaced wholesale on re-import;
 *   verified ones are left untouched.
 */
function importPayments() {
  return action('importPayments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- per-order advisory lock (class 42001): creating PENDING payments
        -- must serialize with the write-off guard, which refuses positive
        -- write-offs while any payment is pending
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), src AS (
        SELECT x.kind,
               CASE WHEN x.value ~ '^0x[0-9a-fA-F]{64}$' THEN lower(x.value) ELSE x.value END AS value,
               x.method
        FROM lck, jsonb_to_recordset({{params.payments}}::jsonb) AS x(kind text, value text, method text)
      ), clear_pending_receipts AS (
        DELETE FROM payments
        WHERE order_id = {{params.order_id}}::bigint
          AND tx_hash IS NULL AND status = 'pending'
          AND EXISTS (SELECT 1 FROM src WHERE kind = 'receipt')
      ), ins_hashes AS (
        INSERT INTO payments (order_id, method, tx_hash, status)
        SELECT DISTINCT ON (s.value) {{params.order_id}}::bigint, s.method::payment_method, s.value, 'pending'
        FROM src s
        WHERE s.kind = 'tx_hash'
          AND NOT EXISTS (
            SELECT 1 FROM payments p
            WHERE (CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END) = s.value
              AND (p.status <> 'rejected' OR p.order_id = {{params.order_id}}::bigint)
          )
        ON CONFLICT ((CASE WHEN tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(tx_hash) ELSE tx_hash END))
          WHERE tx_hash IS NOT NULL AND status <> 'rejected' DO NOTHING
        RETURNING id
      ), ins_receipts AS (
        INSERT INTO payments (order_id, method, receipt_ref, status)
        SELECT {{params.order_id}}::bigint, method::payment_method, value, 'pending'
        FROM src WHERE kind = 'receipt'
        RETURNING id
      ), wo_clear AS (
        -- new incoming payment evidence: a standing write-off must not keep
        -- the order reading matched while it pends — auto-clear, audited;
        -- if the payment fails verification the order shows short again
        DELETE FROM order_writeoffs w
        WHERE w.order_id = {{params.order_id}}::bigint
          AND ((SELECT COUNT(*) FROM ins_hashes) > 0 OR (SELECT COUNT(*) FROM ins_receipts) > 0)
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', 'import',
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'imported_payment')
        FROM wo_clear
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM ins_hashes) AS hashes_added,
             (SELECT COUNT(*) FROM ins_receipts) AS receipts_added
    `,
  });
}

export default importPayments;
