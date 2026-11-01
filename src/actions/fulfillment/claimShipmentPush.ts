import { action } from '@uibakery/data';

/**
 * Claim (or, with prior_claimed_at, renew) the right to push ONE finalized
 * box to the ordering app (migration 1790103200). pushShipmentUpstream
 * claims before it writes anything — local trail or upstream — and renews
 * right before its PUT; the stamp (markShipmentPushed) or a release
 * clears it. Taken under the 42001 order lock, the same lock
 * cancel_finalized_shipment holds, so the two serialize: a cancelled,
 * refund-voided, already-pushed or re-epoched box refuses a claim, and a
 * cancel refuses while a claim is fresh (under 10 minutes).
 *
 * The renewal also stamps push_dispatched_at — the PUT follows at once —
 * and at most ONE dispatched write is ever outstanding per box: neither a
 * claim nor a renewal lands while another push's dispatch is under 10
 * minutes old. Before any dispatch a first claim takes over a standing
 * claim (pushes of one box are idempotent with each other; the displaced
 * push fails its renewal and aborts before writing), so a retry is not
 * locked out by a push that never sent. A dispatch is cleared by the
 * verified stamp, or by its own push's release once the ordering app
 * ANSWERED the PUT (any status: that request is finished); a PUT whose
 * connection dropped with no answer may still land, so its mark stays
 * until verified or 10 minutes old — and the cancel refuses meanwhile.
 * Zero rows = refused. Timestamps travel as text (microsecond-exact).
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
      ts AS (SELECT clock_timestamp() AS t),
      up AS (
        UPDATE shipments s
        SET push_claimed_at = ts.t,
            push_dispatched_at = CASE WHEN COALESCE({{params.prior_claimed_at}}::text, '') <> ''
                                      THEN ts.t ELSE s.push_dispatched_at END
        FROM lck, ts
        WHERE s.id = lck.sid
          AND s.finalized_at IS NOT NULL
          AND s.cancelled_at IS NULL
          AND COALESCE(s.refund_status, '') <> 'SUCCESS'
          AND s.b44_pushed_at IS NULL
          AND s.push_epoch = NULLIF({{params.expected_push_epoch}}::text, '')::int
          -- no other push's sent write is still unresolved
          AND (s.push_dispatched_at IS NULL OR s.push_dispatched_at < now() - interval '10 minutes')
          AND (
            -- first claim: takes the box over from a standing (unsent) claim
            COALESCE({{params.prior_claimed_at}}::text, '') = ''
            -- renewal: only the caller's own standing claim
            OR (s.push_claimed_at = NULLIF({{params.prior_claimed_at}}::text, '')::timestamptz
                AND s.push_claimed_at >= now() - interval '10 minutes'))
        RETURNING s.id, s.push_claimed_at, s.push_dispatched_at
      )
      SELECT up.id, up.push_claimed_at::text AS claimed_at, up.push_dispatched_at::text AS dispatched_at FROM up
    `,
  });
}

export default claimShipmentPush;
