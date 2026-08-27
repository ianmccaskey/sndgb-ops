import { action } from '@uibakery/data';

function saveProduct() {
  return action('saveProduct', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO products (sku_code, name, mass_label, external_id, active)
      VALUES (
        TRIM({{params.sku_code}}::text),
        {{params.name}}::text,
        NULLIF({{params.mass_label}}::text, ''),
        NULLIF({{params.external_id}}::text, ''),
        {{params.active}}::boolean
      )
      ON CONFLICT (sku_code) DO UPDATE SET
        name = EXCLUDED.name,
        mass_label = EXCLUDED.mass_label,
        external_id = COALESCE(EXCLUDED.external_id, products.external_id),
        active = EXCLUDED.active
      RETURNING id
    `,
  });
}

export default saveProduct;
