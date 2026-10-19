import { action } from '@uibakery/data';

/**
 * The SELECTED CAMPAIGN's products in catalog-row shape — drop-in for
 * listProducts wherever a picker must only offer what this buy actually
 * sells (Receiving's package-content pickers, per Ian: "the products
 * being received scoped as well"). Same columns as listProducts so the
 * CatalogProduct type and every consumer work unchanged. external_id is
 * this campaign's ordering-app link (1790101900), not the frozen legacy
 * column.
 */
function listCampaignCatalogProducts() {
  return action('listCampaignCatalogProducts', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT DISTINCT p.id, cpl.external_id, p.sku_code, p.name, p.mass_label,
             p.unit_weight_oz, p.digital, p.active
      FROM products p
      JOIN group_buy_products gbp ON gbp.product_id = p.id
      LEFT JOIN campaign_product_links cpl
        ON cpl.group_buy_id = gbp.group_buy_id AND cpl.product_id = p.id
      WHERE gbp.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY p.sku_code
    `,
  });
}

export default listCampaignCatalogProducts;
