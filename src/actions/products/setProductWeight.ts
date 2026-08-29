import { action } from '@uibakery/data';

/**
 * Authoritative editor for a product's shipping weight — the ONLY path that
 * can change or CLEAR one on an existing row ('' -> NULL; saveProduct sets
 * weight at INSERT only, so the ordering-app sync can never touch a curated
 * weight). expected_weight is a CAS on the value the editor opened with —
 * a stale save refuses (zero rows) instead of clobbering the other admin's
 * newer edit. Weight feeds the shipping modal's box-weight prefill, so
 * changes are audited with old/new.
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
          -- malformed input refuses instead of Postgres rounding it to scale
          AND ({{params.unit_weight_oz}}::text = ''
               OR {{params.unit_weight_oz}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$')
          -- CAS on the value this editor OPENED with: if the other admin
          -- changed the weight meanwhile, this stale save refuses instead
          -- of silently clobbering the newer edit
          AND old.old_weight IS NOT DISTINCT FROM NULLIF({{params.expected_weight}}::text, '')::numeric
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
