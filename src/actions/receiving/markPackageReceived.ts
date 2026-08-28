import { action } from '@uibakery/data';

/**
 * Receive a package — its contents enter the address inventory. Guarded
 * WHERE received_at IS NULL so an auto-receive double-fire refuses
 * harmlessly. mode distinguishes 'auto' (client detected live-mode
 * DELIVERED on refresh) from 'manual' in the audit trail. Requires the
 * package to be committed (a draft has no tracked reality to receive).
 */
function markPackageReceived() {
  return action('markPackageReceived', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE inbound_packages p
        -- a manual receive clears the suppression; an AUTO receive is
        -- DB-refused while it is set, so a manual un-receive sticks no
        -- matter which client refreshes next
        SET received_at = now(), received_by = {{params.actor}}::text, auto_receive_suppressed = false
        WHERE p.id = {{params.package_id}}::bigint
          AND p.received_at IS NULL
          AND p.committed_at IS NOT NULL
          -- a package with no lines would "receive" zero inventory —
          -- refuse until it has contents again
          AND EXISTS (SELECT 1 FROM inbound_package_items i WHERE i.package_id = p.id)
          AND ({{params.mode}}::text <> 'auto' OR NOT p.auto_receive_suppressed)
          -- CAS on the tracking identity: a stale tab whose row was
          -- corrected must not receive inventory for the OLD shipment
          AND p.carrier = LOWER(TRIM({{params.carrier}}::text))
          AND p.tracking_number = UPPER(TRIM({{params.tracking_number}}::text))
        RETURNING p.id, p.carrier, p.tracking_number
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'inbound_packages', up.id::text,
             CASE WHEN {{params.mode}}::text = 'auto' THEN 'package_received_auto' ELSE 'package_received_manual' END,
             {{params.actor}}::text,
             jsonb_build_object('carrier', up.carrier, 'tracking_number', up.tracking_number)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default markPackageReceived;
