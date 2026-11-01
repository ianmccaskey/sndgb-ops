import { action } from '@uibakery/data';

/**
 * Give back a push claim (claimShipmentPush) when the push ends without
 * its stamp — refused, aborted, or sent but unverified — so a retry or a
 * cancel need not wait out the 10-minute window. Only the caller's own
 * claim (exact timestamp) is cleared; zero rows means it was already
 * gone or taken over. Not audited: the claim is a lease, not a fact.
 */
function releaseShipmentPush() {
  return action('releaseShipmentPush', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments s
      SET push_claimed_at = NULL
      WHERE s.id = {{params.shipment_id}}::bigint
        AND s.push_claimed_at = NULLIF({{params.claimed_at}}::text, '')::timestamptz
      RETURNING s.id
    `,
  });
}

export default releaseShipmentPush;
