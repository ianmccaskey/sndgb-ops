import { action } from '@uibakery/data';

/**
 * Write a Shippo tracking snapshot onto a package. Always matches by id
 * (idempotent — refreshing a received or already-DELIVERED package is
 * harmless), and DELIBERATELY NOT audited: refreshes are a frequent
 * informational cache write, not a bookkeeping event (receive/un-receive
 * are the audited state changes).
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
      RETURNING id, tracking_status, tracking_substatus, received_at
    `,
  });
}

export default updatePackageTracking;
