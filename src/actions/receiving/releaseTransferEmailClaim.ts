import { action } from '@uibakery/data';

/**
 * Operator-driven release of an UNVERIFIED transfer-email claim, after
 * a human check of resend.com/emails. Same contract as
 * releaseShipmentEmailClaim.
 */
function releaseTransferEmailClaim() {
  return action('releaseTransferEmailClaim', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE transfers
         SET tracking_email_sent_at = NULL
       WHERE id = {{params.transfer_id}}::bigint
         AND tracking_email_sent_at IS NOT NULL
         AND tracking_email_error IS NOT NULL
      RETURNING id
    `,
  });
}

export default releaseTransferEmailClaim;
