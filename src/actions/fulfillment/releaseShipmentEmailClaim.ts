import { action } from '@uibakery/data';

/**
 * Operator-driven release of an UNVERIFIED email claim, taken only
 * after the human has checked resend.com/emails and found no send.
 * Guarded to rows explicitly holding an error alongside the claim —
 * a clean "emailed" row (sent, no error) can never be released here,
 * and the error text is kept so a failed re-send still has context.
 */
function releaseShipmentEmailClaim() {
  return action('releaseShipmentEmailClaim', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments
         SET tracking_email_sent_at = NULL
       WHERE id = {{params.shipment_id}}::bigint
         AND tracking_email_sent_at IS NOT NULL
         AND tracking_email_error IS NOT NULL
      RETURNING id
    `,
  });
}

export default releaseShipmentEmailClaim;
