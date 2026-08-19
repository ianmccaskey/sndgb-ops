import { action } from '@uibakery/data';

/**
 * Remove one content line — refused once the package is received, and
 * refused for the LAST line of a COMMITTED package (a committed package
 * with zero lines would later receive as silent zero inventory; delete
 * the whole package instead). The parent row is LOCKED (FOR UPDATE) so
 * the delete serializes against a concurrent receive. Audited.
 */
function deletePackageItem() {
  return action('deletePackageItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH parent AS (
        SELECT p.id, p.committed_at FROM inbound_packages p
        JOIN inbound_package_items i0 ON i0.package_id = p.id AND i0.id = {{params.item_id}}::bigint
        WHERE p.received_at IS NULL
        FOR UPDATE OF p
      ),
      del AS (
        DELETE FROM inbound_package_items i
        USING parent
        WHERE i.id = {{params.item_id}}::bigint
          AND i.package_id = parent.id
          AND (parent.committed_at IS NULL
               OR (SELECT count(*) FROM inbound_package_items c WHERE c.package_id = parent.id) > 1)
        RETURNING i.id, i.package_id, i.product_id, i.qty
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
      SELECT 'inbound_package_items', del.id::text, 'package_item_deleted', {{params.actor}},
             jsonb_build_object('package_id', del.package_id, 'product_id', del.product_id, 'qty', del.qty)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deletePackageItem;
