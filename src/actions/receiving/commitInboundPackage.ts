import { action } from '@uibakery/data';

/**
 * Commit a draft: tracking begins. Requires at least one content line —
 * a package with no declared contents can't feed inventory. Idempotent
 * refusal (zero rows) when already committed. Audited.
 */
function commitInboundPackage() {
  return action('commitInboundPackage', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE inbound_packages p
        SET committed_at = now()
        WHERE p.id = {{params.package_id}}::bigint
          AND p.committed_at IS NULL
          AND EXISTS (SELECT 1 FROM inbound_package_items i WHERE i.package_id = p.id)
        RETURNING p.id, p.carrier, p.tracking_number
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'inbound_packages', up.id::text, 'package_committed', {{params.actor}},
             jsonb_build_object('carrier', up.carrier, 'tracking_number', up.tracking_number)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default commitInboundPackage;
