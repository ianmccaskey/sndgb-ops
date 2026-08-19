import { action } from '@uibakery/data';

/**
 * Add or re-quantify one content line (single-row on purpose — the
 * platform rejects multi-row inserts with repeated key columns). Positive
 * qty, max 2 decimals, refused once the package is RECEIVED (its contents
 * are inventory then). Audited.
 */
function addPackageItem() {
  return action('addPackageItem', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        INSERT INTO inbound_package_items (package_id, product_id, qty)
        SELECT p.id, {{params.product_id}}::bigint, ({{params.qty}})::numeric
        FROM inbound_packages p
        WHERE p.id = {{params.package_id}}::bigint
          AND p.received_at IS NULL
          AND ({{params.qty}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.qty}})::numeric > 0
        ON CONFLICT (package_id, product_id) DO UPDATE SET qty = EXCLUDED.qty
        RETURNING id, package_id, product_id, qty
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'inbound_package_items', up.id::text, 'package_item_set', {{params.actor}},
             jsonb_build_object('package_id', up.package_id, 'product_id', up.product_id, 'qty', up.qty)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default addPackageItem;
