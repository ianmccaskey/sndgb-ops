import { action } from '@uibakery/data';

/**
 * A campaign's lines for the COA Reports page: every group_buy_products row
 * of the campaign with its catalog name, and how many reports it holds.
 * `digital` marks the COA add-on lines (the testing purchase itself) — the
 * page lists them after the products they test and hides them unless asked.
 */
function listStorefrontCoaProducts() {
  return action('listStorefrontCoaProducts', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT gbp.id AS group_buy_product_id, p.id AS product_id, p.sku_code, p.name AS product_name,
             p.mass_label, p.digital, gbp.status::text AS status,
             (SELECT count(*) FROM storefront.coa_reports c WHERE c.group_buy_product_id = gbp.id) AS report_count
      FROM group_buy_products gbp
      JOIN products p ON p.id = gbp.product_id
      WHERE gbp.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
      ORDER BY p.digital, p.sku_code, gbp.id
    `,
  });
}

export default listStorefrontCoaProducts;
