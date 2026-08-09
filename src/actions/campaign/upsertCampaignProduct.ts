import { action } from '@uibakery/data';

function upsertCampaignProduct() {
  return action('upsertCampaignProduct', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO group_buy_products
        (group_buy_id, product_id, vendor_id, unit_cost_usd, margin_usd, target_moq, testing_cost_usd, freight_usd)
      VALUES (
        {{params.group_buy_id}}::bigint,
        {{params.product_id}}::bigint,
        {{params.vendor_id}}::bigint,
        {{params.unit_cost_usd}}::numeric,
        {{params.margin_usd}}::numeric,
        {{params.target_moq}}::int,
        {{params.testing_cost_usd}}::numeric,
        {{params.freight_usd}}::numeric
      )
      ON CONFLICT (group_buy_id, product_id) DO UPDATE SET
        vendor_id = EXCLUDED.vendor_id,
        unit_cost_usd = EXCLUDED.unit_cost_usd,
        margin_usd = EXCLUDED.margin_usd,
        target_moq = EXCLUDED.target_moq,
        testing_cost_usd = EXCLUDED.testing_cost_usd,
        freight_usd = EXCLUDED.freight_usd
      RETURNING id
    `,
  });
}

export default upsertCampaignProduct;
