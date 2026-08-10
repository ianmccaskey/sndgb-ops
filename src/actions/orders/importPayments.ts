import { action } from '@uibakery/data';

/**
 * Records imported payment references for an order from a JSON array of
 * {kind: 'tx_hash' | 'receipt', value, method}.
 * - a tx hash that exists in ANY status is skipped: verified payments are
 *   never reset to pending, and rejected hashes are never resurrected by a
 *   re-pull (the correction lives locally until pushed upstream).
 * - pending receipt refs (no hash) are replaced wholesale on re-import;
 *   verified ones are left untouched.
 */
function importPayments() {
  return action('importPayments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH src AS (
        SELECT x.kind, x.value, x.method
        FROM jsonb_to_recordset({{params.payments}}::jsonb) AS x(kind text, value text, method text)
      ), clear_pending_receipts AS (
        DELETE FROM payments
        WHERE order_id = {{params.order_id}}::bigint
          AND tx_hash IS NULL AND status = 'pending'
          AND EXISTS (SELECT 1 FROM src WHERE kind = 'receipt')
      ), ins_hashes AS (
        INSERT INTO payments (order_id, method, tx_hash, status)
        SELECT {{params.order_id}}::bigint, s.method::payment_method, s.value, 'pending'
        FROM src s
        WHERE s.kind = 'tx_hash'
          AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.tx_hash = s.value)
        RETURNING id
      ), ins_receipts AS (
        INSERT INTO payments (order_id, method, receipt_ref, status)
        SELECT {{params.order_id}}::bigint, method::payment_method, value, 'pending'
        FROM src WHERE kind = 'receipt'
        RETURNING id
      )
      SELECT (SELECT COUNT(*) FROM ins_hashes) AS hashes_added,
             (SELECT COUNT(*) FROM ins_receipts) AS receipts_added
    `,
  });
}

export default importPayments;
