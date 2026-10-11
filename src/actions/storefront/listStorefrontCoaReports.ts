import { action } from '@uibakery/data';

/**
 * COA reports attached to the campaign's lines (group_buy_product_id).
 * Catalog-level reports (product_id only) are not campaign rows and are not
 * listed here. `version` is a digest of the stored columns as loaded: the
 * edit and delete actions refuse when the row has changed since (the table
 * has no updated_at to compare). `listing_count` is how many P² store
 * listings cite the report — those keep it (delete is refused).
 */
function listStorefrontCoaReports() {
  return action('listStorefrontCoaReports', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT c.id, c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
             to_char(c.tested_at, 'YYYY-MM-DD') AS tested_at, c.purity_pct::text AS purity_pct,
             c.notes, c.created_by, c.created_at,
             (SELECT count(*) FROM storefront.store_listings sl WHERE sl.coa_report_id = c.id) AS listing_count,
             md5(row(c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
                     c.tested_at, c.purity_pct, c.notes)::text) AS version
      FROM storefront.coa_reports c
      JOIN group_buy_products gbp ON gbp.id = c.group_buy_product_id
      WHERE gbp.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
      ORDER BY c.group_buy_product_id, c.tested_at DESC NULLS LAST, c.id DESC
    `,
  });
}

export default listStorefrontCoaReports;
