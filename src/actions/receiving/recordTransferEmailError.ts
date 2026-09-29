import { action } from '@uibakery/data';

/**
 * Releases a transfer-email claim after a DEFINITIVE Resend refusal
 * (nothing was sent). Same CAS-on-claim-token contract as
 * recordShipmentEmailError.
 */
function recordTransferEmailError() {
  return action('recordTransferEmailError', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE transfers
         SET tracking_email_sent_at = NULL,
             tracking_email_error = {{params.error}}::text
       WHERE id = {{params.transfer_id}}::bigint
         AND tracking_email_sent_at = {{params.claimed_at}}::timestamptz
      RETURNING id
    `,
  });
}

export default recordTransferEmailError;
