import { action } from '@uibakery/data';

/**
 * A storefront payment claim imported here while it was still pending can
 * later be rejected on the storefront (failed on-chain, paid another
 * wallet, never found in a week, a cash receipt that never arrived).
 * Mirror that: the matching LOCAL payment moves to 'rejected' too — but
 * only while it is still pending. A payment this app has already verified
 * itself is never touched (this app's verification is the truth; the
 * storefront's verdict is advisory).
 *
 * Claims come as {kind: 'tx_hash' | 'receipt', value, reason}: a hash
 * matches a hash row (canonical lower-case for EVM), a receipt matches a
 * hash-less row by its receipt reference.
 *
 * Addressed by order NUMBER + campaign (not id) so it also runs for orders
 * that are no longer importable — a cancelled storefront order whose stale
 * pending hash would otherwise keep blocking a live claimant. Only a
 * storefront-imported row is ever touched. Idempotent: a second run
 * matches nothing. Returns the rejected payment ids.
 */
function syncStorefrontRejectedClaims() {
  return action('syncStorefrontRejectedClaims', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ord AS (
        SELECT o.id
        FROM orders o
        WHERE o.order_number = {{params.order_number}}::text
          AND o.group_buy_id = {{params.group_buy_id}}::bigint
          AND o.raw_import->>'source' = 'storefront'
      ), lck AS (
        -- per-order advisory lock (class 42001): payment state feeds due/received
        SELECT pg_advisory_xact_lock(42001, ord.id::int) AS locked FROM ord
      ), src AS (
        SELECT COALESCE(NULLIF(x.kind, ''), 'tx_hash') AS kind,
               CASE WHEN x.value ~ '^0x[0-9a-fA-F]{64}$' THEN lower(x.value) ELSE btrim(x.value) END AS value,
               COALESCE(NULLIF(x.reason, ''), 'rejected by the storefront') AS reason
        FROM jsonb_to_recordset({{params.rejected}}::jsonb) AS x(kind text, value text, reason text)
        WHERE (SELECT COUNT(*) FROM lck) >= 0
          AND NULLIF(btrim(x.value), '') IS NOT NULL
      ), upd AS (
        UPDATE payments p SET
          status = 'rejected',
          notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN 'storefront: ' || s.reason
                       ELSE p.notes || E'\\n' || 'storefront: ' || s.reason END
        FROM ord, src s
        WHERE p.order_id = ord.id
          AND p.status = 'pending'
          AND (
            (s.kind = 'tx_hash' AND p.tx_hash IS NOT NULL
              AND (CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END) = s.value)
            OR
            (s.kind = 'receipt' AND p.tx_hash IS NULL AND p.receipt_ref IS NOT NULL
              AND btrim(p.receipt_ref) = s.value)
          )
        RETURNING p.id, p.order_id, s.reason
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', upd.id::text, 'payment_rejected_by_storefront', {{params.actor}}::text,
               jsonb_build_object('order_id', upd.order_id, 'reason', upd.reason)
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default syncStorefrontRejectedClaims;
