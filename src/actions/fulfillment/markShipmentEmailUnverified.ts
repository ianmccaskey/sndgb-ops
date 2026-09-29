import { action } from '@uibakery/data';

/**
 * Marks an AMBIGUOUS send outcome (Resend may or may not have
 * delivered): the claim is HELD — sent_at stays — and the error is
 * recorded, so the row shows "email unverified" and can never
 * double-send on its own. Releasing it for retry is a deliberate
 * operator act (releaseShipmentEmailClaim) after checking
 * resend.com/emails. CAS on the claim token, same as the release.
 */
function markShipmentEmailUnverified() {
  return action('markShipmentEmailUnverified', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments
         SET tracking_email_error = {{params.error}}::text
       WHERE id = {{params.shipment_id}}::bigint
         AND tracking_email_sent_at = {{params.claimed_at}}::timestamptz
      RETURNING id
    `,
  });
}

export default markShipmentEmailUnverified;
