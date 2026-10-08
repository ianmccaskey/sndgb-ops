import { action } from '@uibakery/data';

/**
 * Create or update a campaign's storefront publishing row. The order-number
 * sequence is never touched here (it is minted under the storefront's own
 * lock); the code is uppercased and, once an order exists, frozen — order
 * numbers already carry it.
 */
function upsertStorefrontCampaign() {
  return action('upsertStorefrontCampaign', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT {{params.group_buy_id}}::bigint AS group_buy_id,
               upper(btrim({{params.code}}::text)) AS code,
               ({{params.published}}::text = 'true') AS published,
               NULLIF({{params.description_md}}::text, '') AS description_md,
               NULLIF({{params.payment_instructions_md}}::text, '') AS payment_instructions_md,
               NULLIF({{params.near_default_rail}}::text, '')::payment_rail AS near_default_rail,
               NULLIF({{params.insurance_rate_pct}}::text, '')::numeric AS insurance_rate_pct
      ), guard AS (
        -- refuse a code change once an order number carries the old code
        SELECT inp.*
        FROM inp
        WHERE inp.code ~ '^[A-Z0-9]{2,8}$'
          AND NOT EXISTS (
            SELECT 1 FROM storefront.campaign_settings cs
            JOIN storefront.orders o ON o.group_buy_id = cs.group_buy_id
            WHERE cs.group_buy_id = inp.group_buy_id AND cs.code <> inp.code
          )
      )
      INSERT INTO storefront.campaign_settings
        (group_buy_id, code, published, description_md, payment_instructions_md, near_default_rail, insurance_rate_pct)
      SELECT group_buy_id, code, published, description_md, payment_instructions_md, near_default_rail, COALESCE(insurance_rate_pct, 1.27)
      FROM guard
      ON CONFLICT (group_buy_id) DO UPDATE SET
        code = EXCLUDED.code,
        published = EXCLUDED.published,
        description_md = EXCLUDED.description_md,
        payment_instructions_md = EXCLUDED.payment_instructions_md,
        near_default_rail = EXCLUDED.near_default_rail,
        insurance_rate_pct = EXCLUDED.insurance_rate_pct
      RETURNING group_buy_id, code, published
    `,
  });
}

export default upsertStorefrontCampaign;
