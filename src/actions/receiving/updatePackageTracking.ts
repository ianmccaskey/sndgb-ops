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
      -- a FAILED lookup (error non-empty) records only the error + check
      -- time and PRESERVES the last good snapshot: a transient Shippo/
      -- network problem must not erase out-for-delivery or attention
      -- signals. A clean fetch (error empty) writes the full snapshot —
      -- including legitimate nulls for a label with no scans yet — and
      -- clears any prior error.
      SET tracking_status = CASE WHEN {{params.error}}::text <> '' THEN tracking_status ELSE NULLIF({{params.status}}::text, '') END,
          tracking_substatus = CASE WHEN {{params.error}}::text <> '' THEN tracking_substatus ELSE NULLIF({{params.substatus}}::text, '') END,
          tracking_detail = CASE WHEN {{params.error}}::text <> '' THEN tracking_detail ELSE NULLIF({{params.detail}}::text, '') END,
          tracking_error = NULLIF({{params.error}}::text, ''),
          tracking_location = CASE WHEN {{params.error}}::text <> '' THEN tracking_location ELSE NULLIF({{params.location}}::text, '')::jsonb END,
          eta = CASE WHEN {{params.error}}::text <> '' THEN eta ELSE NULLIF({{params.eta}}::text, '')::timestamptz END,
          status_date = CASE WHEN {{params.error}}::text <> '' THEN status_date ELSE NULLIF({{params.status_date}}::text, '')::timestamptz END,
          last_checked_at = now()
      WHERE id = {{params.package_id}}::bigint
        AND carrier = LOWER(TRIM({{params.carrier}}))
        AND tracking_number = UPPER(TRIM({{params.tracking_number}}))
      RETURNING id, tracking_status, tracking_substatus, received_at
    `,
  });
}

export default updatePackageTracking;
