import { action } from '@uibakery/data';

/**
 * One campaign's ordering-app product links (campaign_product_links,
 * 1790101900): which base44 Product record stands for which local
 * product IN THIS CAMPAIGN. base44 keeps a separate Product per group
 * buy, so a link is never shared across campaigns. The order importer
 * maps pulled items with it, the product sync matches with it, and the
 * catalog shows it. group_buy_id travels with every row so a consumer
 * can drop rows a campaign switch left behind.
 */
function listCampaignProductLinks() {
  return action('listCampaignProductLinks', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT l.group_buy_id, l.product_id, l.external_id, p.sku_code
      FROM campaign_product_links l
      JOIN products p ON p.id = l.product_id
      WHERE l.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
      ORDER BY p.sku_code
    `,
  });
}

export default listCampaignProductLinks;
