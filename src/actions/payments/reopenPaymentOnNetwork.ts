import { action } from '@uibakery/data';

/**
 * Re-open a REJECTED tx-hash payment as pending on a DIFFERENT network — the
 * "right hash, wrong network" correction (customer picked ETH at checkout but
 * paid on Solana). addPaymentHash deliberately refuses re-adding a hash that
 * was rejected on the same order, so this explicit, audited path is the only
 * way back — and only sideways onto another network, never a plain undo:
 *
 *  - the payment must be rejected, on this order, with a tx hash;
 *  - the target method must DIFFER from the recorded one;
 *  - the hash must be plausible for the target network (0x-hex for eth/base,
 *    base58 for sol) — the network mix-up is the whole premise;
 *  - the canonical hash must not live on any other non-rejected payment
 *    (it may have been legitimately reattached elsewhere since);
 *  - status/verification reset to pending, so it re-earns 'verified' through
 *    the normal on-chain check, never by assertion.
 *
 * Update + note + audit are one statement: no unaudited state change.
 * Returns reopened=0 when any guard fails.
 */
function reopenPaymentOnNetwork() {
  return action('reopenPaymentOnNetwork', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), tgt AS (
        SELECT p.id, p.tx_hash, p.method AS old_method,
          CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END AS canon
        FROM lck, payments p
        WHERE p.id = {{params.payment_id}}::bigint
          AND p.order_id = {{params.order_id}}::bigint
          AND p.status = 'rejected'
          AND p.tx_hash IS NOT NULL AND p.tx_hash <> ''
          AND p.method <> {{params.method}}::payment_method
      ), upd AS (
        UPDATE payments p SET
          method = {{params.method}}::payment_method,
          status = 'pending',
          verify_source = NULL,
          verified_at = NULL,
          notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN {{params.note}}
                       ELSE p.notes || E'\\n' || {{params.note}} END,
          updated_at = now()
        FROM tgt
        WHERE p.id = tgt.id
          AND (
            ({{params.method}} IN ('eth','base') AND tgt.tx_hash ~ '^0x[0-9a-fA-F]{64}$')
            OR ({{params.method}} = 'sol' AND tgt.tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{64,90}$')
          )
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
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'payment_reopened')
        FROM wo_clear
        RETURNING row_pk
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', upd.id::text, 'payment_reopened_on_network', {{params.actor}},
               jsonb_build_object('from_method', (SELECT old_method FROM tgt), 'to_method', upd.method, 'note', {{params.note}})
        FROM upd
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM upd) AS reopened
    `,
  });
}

export default reopenPaymentOnNetwork;
