import { action } from '@uibakery/data';

function listProducts() {
  return action('listProducts', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, external_id, sku_code, name, mass_label, unit_weight_oz, digital, active
      FROM products
      ORDER BY name, sku_code
    `,
  });
}

export default listProducts;
