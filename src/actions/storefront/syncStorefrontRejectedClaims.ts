import { action } from '@uibakery/data';

/**
 * A storefront payment claim imported here while it was still pending can
 * later be rejected on the storefront (failed on-chain, paid another
 * wallet, never found in a week). Mirror that: the matching LOCAL payment on
 * this order moves to 'rejected' too — but only while it is still pending.
 * A payment this app has already verified itself is never touched (this
 * app's verification is the truth; the storefront's verdict is advisory).
 * Idempotent: a second run matches nothing.
 */
function syncStorefrontRejectedClaims() {
  return action('syncStorefrontRejectedClaims', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- per-order advisory lock (class 42001): payment state feeds due/received
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), src AS (
        SELECT CASE WHEN x.hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(x.hash) ELSE x.hash END AS hash,
               COALESCE(NULLIF(x.reason, ''), 'rejected by the storefront') AS reason
        FROM lck, jsonb_to_recordset({{params.rejected}}::jsonb) AS x(hash text, reason text)
      ), upd AS (
        UPDATE payments p SET
          status = 'rejected',
          notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN 'storefront: ' || s.reason
                       ELSE p.notes || E'\\n' || 'storefront: ' || s.reason END
        FROM src s
        WHERE p.order_id = {{params.order_id}}::bigint
          AND p.status = 'pending'
          AND p.tx_hash IS NOT NULL
          AND (CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END) = s.hash
        RETURNING p.id, s.reason
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', upd.id::text, 'payment_rejected_by_storefront', {{params.actor}}::text,
               jsonb_build_object('order_id', {{params.order_id}}::bigint, 'reason', upd.reason)
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default syncStorefrontRejectedClaims;
