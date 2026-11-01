import { action } from '@uibakery/data';

/**
 * Claim (or, with prior_claimed_at, renew) the right to push ONE finalized
 * box to the ordering app (migration 1790103200). pushShipmentUpstream
 * claims before it writes anything — local trail or upstream — and renews
 * right before its PUT; the stamp (markShipmentPushed) or a release
 * clears it. Taken under the 42001 order lock, the same lock
 * cancel_finalized_shipment holds, so the two serialize: a cancelled,
 * refund-voided, already-pushed or re-epoched box refuses a claim, and a
 * cancel refuses while a claim is fresh (under 10 minutes). The claim
 * blocks CANCELS, not other pushes — two pushes of one box are idempotent
 * with each other — so a first claim takes over any standing one; the
 * push it displaced fails its renewal and aborts before writing. The
 * renewal lands only on the caller's own claim (exact timestamp) and
 * also stamps push_dispatched_at: the PUT follows at once, and a sent
 * request may land whatever the tab hears back, so only the verified
 * stamp (markShipmentPushed) clears that mark — a release never does,
 * and the cancel refuses while it is fresh. Zero rows = refused.
 * claimed_at travels as text (microsecond-exact).
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
        SET push_claimed_at = clock_timestamp(),
            -- the renewal is taken right before the PUT: from it the write
            -- counts as dispatched until the verified stamp clears it
            push_dispatched_at = CASE WHEN COALESCE({{params.prior_claimed_at}}::text, '') <> ''
                                      THEN clock_timestamp() ELSE s.push_dispatched_at END
        FROM lck
        WHERE s.id = lck.sid
          AND s.finalized_at IS NOT NULL
          AND s.cancelled_at IS NULL
          AND COALESCE(s.refund_status, '') <> 'SUCCESS'
          AND s.b44_pushed_at IS NULL
          AND s.push_epoch = NULLIF({{params.expected_push_epoch}}::text, '')::int
          AND (
            -- first claim: takes the box over from any standing claim
            COALESCE({{params.prior_claimed_at}}::text, '') = ''
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
