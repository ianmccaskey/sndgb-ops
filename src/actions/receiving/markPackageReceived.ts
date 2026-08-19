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
        SET received_at = now(), received_by = {{params.actor}}
        WHERE p.id = {{params.package_id}}::bigint
          AND p.received_at IS NULL
          AND p.committed_at IS NOT NULL
        RETURNING p.id, p.carrier, p.tracking_number
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'inbound_packages', up.id::text,
             CASE WHEN {{params.mode}}::text = 'auto' THEN 'package_received_auto' ELSE 'package_received_manual' END,
             {{params.actor}},
             jsonb_build_object('carrier', up.carrier, 'tracking_number', up.tracking_number)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default markPackageReceived;
