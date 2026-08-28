import { action } from '@uibakery/data';

/**
 * Correct a typo'd carrier/tracking on a committed package WITHOUT losing
 * its audit trail — allowed while unreceived. Clears the stale Shippo
 * snapshot in the same statement so the old carrier's status can't linger
 * under the new number, and RESETS auto_receive_suppressed: suppression
 * was the operator's verdict on the OLD tracking identity (un-received a
 * bad number); the corrected number is fresh reality and must auto-receive
 * normally, or a fixed typo would strand the package understating
 * inventory forever. Audited with old and new values. A collision with
 * another active package throws 23505 — the page explains.
 */
function updatePackageCarrierTracking() {
  return action('updatePackageCarrierTracking', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE inbound_packages p
        SET carrier = LOWER(TRIM({{params.carrier}}::text)),
            tracking_number = UPPER(TRIM({{params.tracking_number}}::text)),
            tracking_status = NULL, tracking_substatus = NULL, tracking_detail = NULL,
            tracking_error = NULL, tracking_location = NULL, eta = NULL,
            status_date = NULL, last_checked_at = NULL,
            auto_receive_suppressed = false
        FROM (SELECT id, carrier AS old_carrier, tracking_number AS old_tracking FROM inbound_packages WHERE id = {{params.package_id}}::bigint) old
        WHERE p.id = old.id
          AND p.received_at IS NULL
          AND TRIM({{params.carrier}}::text) <> '' AND TRIM({{params.tracking_number}}::text) <> ''
          -- CAS on the identity the dialog OPENED with: if another session
          -- corrected this package meanwhile, this stale save refuses
          -- instead of silently repointing the row a second time
          AND old.old_carrier = LOWER(TRIM({{params.expected_carrier}}::text))
          AND old.old_tracking = UPPER(TRIM({{params.expected_tracking}}::text))
        RETURNING p.id, old.old_carrier, old.old_tracking, p.carrier, p.tracking_number
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
      SELECT 'inbound_packages', up.id::text, 'package_tracking_corrected', {{params.actor}}::text,
             jsonb_build_object('carrier', up.old_carrier, 'tracking_number', up.old_tracking),
             jsonb_build_object('carrier', up.carrier, 'tracking_number', up.tracking_number)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default updatePackageCarrierTracking;
