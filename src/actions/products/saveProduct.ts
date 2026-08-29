import { action } from '@uibakery/data';

function saveProduct() {
  return action('saveProduct', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO products (sku_code, name, mass_label, external_id, unit_weight_oz, active)
      SELECT
        TRIM({{params.sku_code}}::text),
        {{params.name}}::text,
        NULLIF({{params.mass_label}}::text, ''),
        NULLIF({{params.external_id}}::text, ''),
        NULLIF({{params.unit_weight_oz}}::text, '')::numeric,
        {{params.active}}::boolean
      -- a malformed weight refuses the whole insert (zero rows) instead of
      -- Postgres silently rounding an over-precision value to the column
      -- scale — the UI regex is a convenience, this is the guard
      WHERE ({{params.unit_weight_oz}}::text = ''
             OR {{params.unit_weight_oz}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$')
      ON CONFLICT (sku_code) DO UPDATE SET
        name = EXCLUDED.name,
        mass_label = EXCLUDED.mass_label,
        external_id = COALESCE(EXCLUDED.external_id, products.external_id),
        -- weight applies at INSERT only (the add-product form). An existing
        -- row's weight NEVER changes through this generic upsert — the
        -- ordering-app sync calls it blind, and an edit here would bypass
        -- the audited editor. All changes go through setProductWeight.
        active = EXCLUDED.active
      -- (xmax = 0) discriminates a true insert from a conflict-update, so
      -- the add form can tell the operator when a supplied weight did NOT
      -- apply (existing SKU keeps its curated weight)
      RETURNING id, (xmax = 0) AS inserted
    `,
  });
}

export default saveProduct;
