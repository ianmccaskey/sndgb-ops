import { action } from '@uibakery/data';

/**
 * Write a Shippo tracking snapshot onto an ORDER shipment — same contract
 * as receiving's updatePackageTracking: CAS on the tracking identity
 * (carrier + number as fetched, so a stale tab can't stamp a corrected
 * shipment), error-only writes preserve the last good snapshot, and the
 * write is deliberately NOT audited (informational cache, not
 * bookkeeping). shipments.status is untouched: the carrier's word and
 * the operator's state machine are separate truths.
 */
function updateShipmentTracking() {
  return action('updateShipmentTracking', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments
      SET tracking_status = CASE WHEN {{params.error}}::text <> '' THEN tracking_status ELSE NULLIF({{params.status}}::text, '') END,
          tracking_substatus = CASE WHEN {{params.error}}::text <> '' THEN tracking_substatus ELSE NULLIF({{params.substatus}}::text, '') END,
          tracking_status_date = CASE WHEN {{params.error}}::text <> '' THEN tracking_status_date ELSE NULLIF({{params.status_date}}::text, '')::timestamptz END,
          eta = CASE WHEN {{params.error}}::text <> '' THEN eta ELSE NULLIF({{params.eta}}::text, '')::timestamptz END,
          tracking_error = NULLIF({{params.error}}::text, ''),
          tracking_checked_at = now()
      WHERE id = {{params.shipment_id}}::bigint
        AND LOWER(COALESCE(carrier, '')) = LOWER(TRIM({{params.carrier}}::text))
        AND UPPER(COALESCE(tracking_number, '')) = UPPER(TRIM({{params.tracking_number}}::text))
      RETURNING id, tracking_status
    `,
  });
}

export default updateShipmentTracking;
