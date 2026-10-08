import { action } from '@uibakery/data';

/** The storefront publishing row for a campaign (none = never set up). */
function getStorefrontCampaign() {
  return action('getStorefrontCampaign', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT cs.group_buy_id, cs.code, cs.published, cs.description_md, cs.payment_instructions_md,
             cs.near_default_rail::text AS near_default_rail, cs.insurance_rate_pct, cs.next_order_seq,
             cs.hero_media_id, cs.created_at, cs.updated_at
      FROM storefront.campaign_settings cs
      WHERE cs.group_buy_id = {{params.group_buy_id}}::bigint
    `,
  });
}

export default getStorefrontCampaign;
