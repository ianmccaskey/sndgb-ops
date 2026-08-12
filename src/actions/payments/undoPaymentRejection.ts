import { action } from '@uibakery/data';

/**
 * Undo a MISTAKEN rejection: flip a rejected tx-hash payment back to pending
 * on its recorded network. This is deliberately NOT what addPaymentHash does
 * (it refuses same-order rejected hashes so an audited rejection can't be
 * quietly re-added) and NOT what reopenPaymentOnNetwork does (that requires a
 * DIFFERENT network — the wrong-network correction). Undoing outright is its
 * own explicit, audited act:
 *  - a non-empty reason is REQUIRED — "why was the rejection wrong";
 *  - the canonical hash must not live on any other non-rejected payment
 *    (it may have been legitimately reattached elsewhere since);
 *  - verification resets, so the payment re-earns 'verified' through the
 *    normal on-chain check, never by assertion.
 * Update + note + audit are one statement; refused = no rows.
 */
function undoPaymentRejection() {
  return action('undoPaymentRejection', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), tgt AS (
        SELECT p.id,
          CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END AS canon
        FROM lck, payments p
        WHERE p.id = {{params.payment_id}}::bigint
          AND p.order_id = {{params.order_id}}::bigint
          AND p.status = 'rejected'
          AND p.tx_hash IS NOT NULL AND p.tx_hash <> ''
      ), upd AS (
        UPDATE payments p SET
          status = 'pending',
          verify_source = NULL,
          verified_at = NULL,
          notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN {{params.note}}
                       ELSE p.notes || E'\\n' || {{params.note}} END,
          updated_at = now()
        FROM tgt
        WHERE p.id = tgt.id
          AND LENGTH(TRIM({{params.reason}})) > 0
          AND NOT EXISTS (
            SELECT 1 FROM payments q
            WHERE q.id <> tgt.id AND q.status <> 'rejected'
              AND (CASE WHEN q.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(q.tx_hash) ELSE q.tx_hash END) = tgt.canon
          )
        RETURNING p.id, p.method
      ), wo_clear AS (
        -- new incoming payment evidence: a standing write-off must not keep
        -- the order reading matched while this pends — auto-clear, audited;
        -- if the payment fails verification the order shows short again
        DELETE FROM order_writeoffs w
        USING upd
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'rejection_undone')
        FROM wo_clear
        RETURNING row_pk
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', upd.id::text, 'payment_rejection_undone', {{params.actor}},
               jsonb_build_object('method', upd.method, 'reason', {{params.reason}}, 'note', {{params.note}})
        FROM upd
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM upd) AS reopened
    `,
  });
}

export default undoPaymentRejection;
