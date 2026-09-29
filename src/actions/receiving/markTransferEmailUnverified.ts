import { action } from '@uibakery/data';

/**
 * Marks an AMBIGUOUS transfer-email outcome — claim held, error
 * recorded, "email unverified" in the UI. Same contract as
 * markShipmentEmailUnverified.
 */
function markTransferEmailUnverified() {
  return action('markTransferEmailUnverified', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE transfers
         SET tracking_email_error = {{params.error}}::text
       WHERE id = {{params.transfer_id}}::bigint
         AND tracking_email_sent_at = {{params.claimed_at}}::timestamptz
      RETURNING id
    `,
  });
}

export default markTransferEmailUnverified;
