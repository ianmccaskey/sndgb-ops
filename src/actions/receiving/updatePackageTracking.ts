import { action } from '@uibakery/data';

/**
 * Write a Shippo tracking snapshot onto a package. COMPARE-AND-SWAP on
 * the tracking identity: the write refuses (zero rows, harmless) unless
 * the row still carries the carrier + tracking number the snapshot was
 * FETCHED for — a stale tab refreshing an old number can no longer
 * overwrite a corrected package's state. Refreshing a received or
 * already-DELIVERED package remains idempotent. DELIBERATELY NOT
 * audited: refreshes are a frequent informational cache write, not a
 * bookkeeping event (receive/un-receive are the audited state changes).
 */
function updatePackageTracking() {
  return action('updatePackageTracking', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE inbound_packages
      SET tracking_status = NULLIF({{params.status}}::text, ''),
          tracking_substatus = NULLIF({{params.substatus}}::text, ''),
          tracking_detail = NULLIF({{params.detail}}::text, ''),
          tracking_error = NULLIF({{params.error}}::text, ''),
          tracking_location = NULLIF({{params.location}}::text, '')::jsonb,
          eta = NULLIF({{params.eta}}::text, '')::timestamptz,
          status_date = NULLIF({{params.status_date}}::text, '')::timestamptz,
          last_checked_at = now()
      WHERE id = {{params.package_id}}::bigint
        AND carrier = LOWER(TRIM({{params.carrier}}))
        AND tracking_number = UPPER(TRIM({{params.tracking_number}}))
      RETURNING id, tracking_status, tracking_substatus, received_at
    `,
  });
}

export default updatePackageTracking;
