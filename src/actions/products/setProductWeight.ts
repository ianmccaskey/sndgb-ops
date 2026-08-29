import { action } from '@uibakery/data';

/**
 * Authoritative editor for a product's shipping weight — the ONLY path that
 * can CLEAR one ('' -> NULL; saveProduct's upsert is set-if-provided so the
 * ordering-app sync can never wipe a curated weight). Weight feeds the
 * shipping modal's box-weight prefill, so changes are audited with old/new.
 */
function setProductWeight() {
  return action('setProductWeight', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE products p
        SET unit_weight_oz = NULLIF({{params.unit_weight_oz}}::text, '')::numeric
        FROM (SELECT id, unit_weight_oz AS old_weight FROM products WHERE id = {{params.product_id}}::bigint) old
        WHERE p.id = old.id
        RETURNING p.id, old.old_weight, p.unit_weight_oz
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
      SELECT 'products', up.id::text, 'product_weight_set', {{params.actor}}::text,
             jsonb_build_object('unit_weight_oz', up.old_weight),
             jsonb_build_object('unit_weight_oz', up.unit_weight_oz)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default setProductWeight;
