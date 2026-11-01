import { action } from '@uibakery/data';

/**
 * Give back a push claim (claimShipmentPush) when the push ends without
 * its stamp — refused, aborted, or answered but unverified — so a retry or
 * a cancel need not wait out the 10-minute window. Only the caller's own
 * claim (exact timestamp) is cleared. dispatched_at is passed only when
 * the push's PUT was ANSWERED by the ordering app (that request is
 * finished): then its own dispatch mark is cleared too. A PUT whose
 * connection dropped unanswered passes '' and its mark stays — the
 * request may still land — until a verified stamp or 10 minutes. Zero
 * rows means both were already gone or taken over. Not audited: these
 * are leases, not facts.
 */
function releaseShipmentPush() {
  return action('releaseShipmentPush', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments s
      SET push_claimed_at = CASE WHEN s.push_claimed_at = NULLIF({{params.claimed_at}}::text, '')::timestamptz
                                 THEN NULL ELSE s.push_claimed_at END,
          push_dispatched_at = CASE WHEN s.push_dispatched_at = NULLIF({{params.dispatched_at}}::text, '')::timestamptz
                                    THEN NULL ELSE s.push_dispatched_at END
      WHERE s.id = {{params.shipment_id}}::bigint
        AND (s.push_claimed_at = NULLIF({{params.claimed_at}}::text, '')::timestamptz
             OR s.push_dispatched_at = NULLIF({{params.dispatched_at}}::text, '')::timestamptz)
      RETURNING s.id
    `,
  });
}

export default releaseShipmentPush;
