import { action } from '@uibakery/data';

function saveProduct() {
  return action('saveProduct', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO products (sku_code, name, mass_label, external_id, unit_weight_oz, active)
      VALUES (
        TRIM({{params.sku_code}}::text),
        {{params.name}}::text,
        NULLIF({{params.mass_label}}::text, ''),
        NULLIF({{params.external_id}}::text, ''),
        NULLIF({{params.unit_weight_oz}}::text, '')::numeric,
        {{params.active}}::boolean
      )
      ON CONFLICT (sku_code) DO UPDATE SET
        name = EXCLUDED.name,
        mass_label = EXCLUDED.mass_label,
        external_id = COALESCE(EXCLUDED.external_id, products.external_id),
        -- set-if-provided: the ordering-app catalog sync knows nothing about
        -- shipping weight, and a blank must never wipe a curated one — the
        -- only way to CLEAR a weight is setProductWeight
        unit_weight_oz = COALESCE(EXCLUDED.unit_weight_oz, products.unit_weight_oz),
        active = EXCLUDED.active
      RETURNING id
    `,
  });
}

export default saveProduct;
