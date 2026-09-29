import { action } from '@uibakery/data';

/**
 * Releases a failed transfer-email claim (direct-ship customer emails):
 * clears the sent_at claim and records the error for the retry
 * affordance. Guarded on the claim still being held.
 */
function recordTransferEmailError() {
  return action('recordTransferEmailError', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE transfers
         SET tracking_email_sent_at = NULL,
             tracking_email_error = {{params.error}}::text
       WHERE id = {{params.transfer_id}}::bigint
         AND tracking_email_sent_at IS NOT NULL
      RETURNING id
    `,
  });
}

export default recordTransferEmailError;
