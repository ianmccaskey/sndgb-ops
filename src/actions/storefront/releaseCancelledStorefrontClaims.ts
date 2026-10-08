import { action } from '@uibakery/data';

/**
 * A storefront order that was cancelled may still hold a tx hash HERE: its
 * claim was imported while the order was live, and this app keeps a hash on
 * ONE order — so the stale copy blocks the live order that now claims the
 * same hash (importPayments skips any hash a non-rejected payment holds),
 * while sitting on an order the views already exclude.
 *
 * Release what is safe to release: a PENDING copy on the cancelled order
 * (never verified by this app — evidence of nothing) moves to 'rejected'
 * with a note naming the live claimant, audited. A VERIFIED or MISMATCH copy
 * is money this app saw land; a pull never moves it — it is reported as
 * 'held' so the live order's import row turns red until an operator rejects
 * or reassigns it by hand.
 *
 * Addressed by order NUMBER + campaign (a cancelled order is not importable,
 * so there is no id), storefront-imported rows only. The local row need not
 * be cancelled yet — the status sync runs later in the same pull. Idempotent.
 * Returns one row per matching hash: {hash, outcome: 'released' | 'held',
 * status}; a hash this order does not hold returns nothing.
 */
function releaseCancelledStorefrontClaims() {
  return action('releaseCancelledStorefrontClaims', 'SQL', {
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
        SELECT CASE WHEN x.hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(x.hash) ELSE btrim(x.hash) END AS hash,
               NULLIF(btrim(x.claimant), '') AS claimant
        FROM jsonb_to_recordset({{params.hashes}}::jsonb) AS x(hash text, claimant text)
        WHERE (SELECT COUNT(*) FROM lck) >= 0
          AND NULLIF(btrim(x.hash), '') IS NOT NULL
      ), upd AS (
        UPDATE payments p SET
          status = 'rejected',
          notes = CASE WHEN p.notes IS NULL OR p.notes = '' THEN 'storefront: order cancelled — tx released to ' || COALESCE(s.claimant, 'its live claimant')
                       ELSE p.notes || E'\\n' || 'storefront: order cancelled — tx released to ' || COALESCE(s.claimant, 'its live claimant') END
        FROM ord, src s
        WHERE p.order_id = ord.id
          AND p.status = 'pending'
          AND p.tx_hash IS NOT NULL
          AND (CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END) = s.hash
        RETURNING p.id, p.order_id, p.tx_hash, s.claimant
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', upd.id::text, 'payment_released_cancelled_order', {{params.actor}}::text,
               jsonb_build_object('order_id', upd.order_id, 'tx_hash', upd.tx_hash, 'released_to', upd.claimant)
        FROM upd
        RETURNING row_pk
      )
      SELECT (CASE WHEN upd.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(upd.tx_hash) ELSE upd.tx_hash END) AS hash,
             'released' AS outcome, 'rejected' AS status
      FROM upd
      UNION ALL
      -- money this app verified itself stays put; the runner flags the live claimant
      SELECT s.hash, 'held' AS outcome, p.status::text AS status
      FROM ord, src s, payments p
      WHERE p.order_id = ord.id
        AND p.tx_hash IS NOT NULL
        AND p.status IN ('verified', 'mismatch')
        AND (CASE WHEN p.tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(p.tx_hash) ELSE p.tx_hash END) = s.hash
    `,
  });
}

export default releaseCancelledStorefrontClaims;
