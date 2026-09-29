import { action } from '@uibakery/data';

/**
 * Releases a shipment-email claim after a DEFINITIVE Resend refusal
 * (nothing was sent): clears the sent_at claim and records the
 * operator-readable error so the row offers a retry. CAS on the exact
 * claim token the claim action returned — a duplicated or replayed
 * release can never clear a LATER claim's successful send. Callers
 * check RETURNING: zero rows = the release did not land, and the row
 * may wrongly read "emailed" until reloaded and released by hand.
 */
function recordShipmentEmailError() {
  return action('recordShipmentEmailError', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments
         SET tracking_email_sent_at = NULL,
             tracking_email_error = {{params.error}}::text
       WHERE id = {{params.shipment_id}}::bigint
         AND tracking_email_sent_at = {{params.claimed_at}}::timestamptz
      RETURNING id
    `,
  });
}

export default recordShipmentEmailError;
