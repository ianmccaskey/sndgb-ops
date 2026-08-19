import { action } from '@uibakery/data';

/** Remove one content line — refused once the package is received. Audited. */
function deletePackageItem() {
  return action('deletePackageItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH del AS (
        DELETE FROM inbound_package_items i
        USING inbound_packages p
        WHERE i.id = {{params.item_id}}::bigint
          AND p.id = i.package_id
          AND p.received_at IS NULL
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
