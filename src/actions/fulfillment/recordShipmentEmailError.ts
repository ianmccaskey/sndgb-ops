import { action } from '@uibakery/data';

/**
 * Releases a failed shipment-email claim: clears the sent_at claim and
 * records the operator-readable error so the shipment row can offer a
 * retry. Guarded on the claim still being held — a stale failure from a
 * lost session must not clear a later successful send.
 */
function recordShipmentEmailError() {
  return action('recordShipmentEmailError', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments
         SET tracking_email_sent_at = NULL,
             tracking_email_error = {{params.error}}::text
       WHERE id = {{params.shipment_id}}::bigint
         AND tracking_email_sent_at IS NOT NULL
      RETURNING id
    `,
  });
}

export default recordShipmentEmailError;
