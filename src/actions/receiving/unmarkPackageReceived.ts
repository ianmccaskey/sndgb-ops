import { action } from '@uibakery/data';

/**
 * Undo a mistaken receive — the contents leave inventory (on-hand may go
 * NEGATIVE if a transfer already went out; the inventory tab renders that
 * amber rather than blocking). NOTE: if this package's tracking number
 * has since been reused by another ACTIVE package, the partial unique
 * index throws 23505 — the page explains ("number now in use"). Audited.
 */
function unmarkPackageReceived() {
  return action('unmarkPackageReceived', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE inbound_packages p
        SET received_at = NULL, received_by = NULL
        WHERE p.id = {{params.package_id}}::bigint
          AND p.received_at IS NOT NULL
        RETURNING p.id, p.carrier, p.tracking_number
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'inbound_packages', up.id::text, 'package_unreceived', {{params.actor}},
             jsonb_build_object('carrier', up.carrier, 'tracking_number', up.tracking_number)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default unmarkPackageReceived;
