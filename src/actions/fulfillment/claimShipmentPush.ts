import { action } from '@uibakery/data';

/**
 * Claim (or, with prior_claimed_at, renew) the right to push ONE finalized
 * box to the ordering app (migration 1790103200). pushShipmentUpstream
 * claims before it writes anything — local trail or upstream — and renews
 * right before its PUT; the stamp (markShipmentPushed) or a release
 * clears it. Taken under the 42001 order lock, the same lock
 * cancel_finalized_shipment holds, so the two serialize: a cancelled,
 * refund-voided, already-pushed or re-epoched box refuses a claim, and a
 * cancel refuses while a claim is fresh. A first claim also refuses while
 * another push holds a fresh one (two tabs never push one box at once);
 * a claim older than 10 minutes is a dead tab's and is taken over. The
 * renewal lands only on the caller's own claim (exact timestamp), so a
 * tab that slept past the window learns it lost the box and aborts.
 * Zero rows = refused. claimed_at travels as text (microsecond-exact).
 */
function claimShipmentPush() {
  return action('claimShipmentPush', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT s.id AS sid, pg_advisory_xact_lock(42001, s.order_id::int) AS locked
        FROM shipments s
        WHERE s.id = {{params.shipment_id}}::bigint
      ),
      up AS (
        UPDATE shipments s
        SET push_claimed_at = clock_timestamp()
        FROM lck
        WHERE s.id = lck.sid
          AND s.finalized_at IS NOT NULL
          AND s.cancelled_at IS NULL
          AND COALESCE(s.refund_status, '') <> 'SUCCESS'
          AND s.b44_pushed_at IS NULL
          AND s.push_epoch = NULLIF({{params.expected_push_epoch}}::text, '')::int
          AND (
            -- first claim: nobody holds a live one
            (COALESCE({{params.prior_claimed_at}}::text, '') = ''
             AND (s.push_claimed_at IS NULL OR s.push_claimed_at < now() - interval '10 minutes'))
            -- renewal: only the caller's own standing claim
            OR (COALESCE({{params.prior_claimed_at}}::text, '') <> ''
                AND s.push_claimed_at = NULLIF({{params.prior_claimed_at}}::text, '')::timestamptz
                AND s.push_claimed_at >= now() - interval '10 minutes'))
        RETURNING s.id, s.push_claimed_at
      )
      SELECT up.id, up.push_claimed_at::text AS claimed_at FROM up
    `,
  });
}

export default claimShipmentPush;
