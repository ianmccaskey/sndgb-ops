import { action } from '@uibakery/data';

/**
 * Move a PENDING tx-hash payment to the network its hash was actually found
 * on — the auto-reconcile pass's one correction. The premise is on-chain
 * evidence the caller just gathered: the hash was not found (or paid no
 * wallet of ours) on the recorded network and WAS found paying our wallet
 * on exactly one other network its shape fits. The payment stays pending;
 * it earns 'verified' through the normal chain check on the new network
 * right after, never by assertion. Guards (repointed = 0 when any fails):
 *  - pending, on this order, with a tx hash;
 *  - still on the network the caller looked at (expected_method) — a row
 *    another operator moved meanwhile is not the row this evidence is for;
 *  - the target differs from the recorded network and the hash's shape
 *    fits it (0x-hex → eth/base, base58 → sol).
 * Update + note + audit (payment_auto_repointed, with the evidence) are one
 * statement under the per-order advisory lock (class 42001).
 */
function repointPendingPaymentNetwork() {
  return action('repointPendingPaymentNetwork', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), tgt AS (
        SELECT p.id, p.tx_hash, p.method AS old_method
        FROM lck, payments p
        WHERE p.id = {{params.payment_id}}::bigint
          AND p.order_id = {{params.order_id}}::bigint
          AND p.status = 'pending'
          AND p.tx_hash IS NOT NULL AND p.tx_hash <> ''
          AND p.method::text = {{params.expected_method}}::text
          AND p.method <> {{params.method}}::text::payment_method
      ), upd AS (
        UPDATE payments p SET
          method = {{params.method}}::text::payment_method,
          notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN {{params.note}}::text
                       ELSE p.notes || E'\\n' || {{params.note}}::text END,
          updated_at = now()
        FROM tgt
        WHERE p.id = tgt.id
          AND (
            ({{params.method}}::text IN ('eth','base') AND tgt.tx_hash ~ '^0x[0-9a-fA-F]{64}$')
            OR ({{params.method}}::text = 'sol' AND tgt.tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$')
          )
        RETURNING p.id, p.order_id, p.method
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', upd.id::text, 'payment_auto_repointed', {{params.actor}}::text,
               jsonb_build_object('order_id', upd.order_id, 'from_method', (SELECT old_method FROM tgt), 'to_method', upd.method,
                                  'evidence', {{params.evidence}}::jsonb, 'note', {{params.note}}::text)
        FROM upd
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM upd) AS repointed
    `,
  });
}

export default repointPendingPaymentNetwork;
