import { action } from '@uibakery/data';

/**
 * Create or update a campaign's storefront publishing row.
 *
 * Order numbers are `YYYY-<CODE>-NNN`, minted by the storefront from
 * next_order_seq under its own lock. A campaign may already hold orders with
 * that shape from the ordering app (base44 numbers look identical), so the
 * sequence always starts ABOVE every existing local or storefront number
 * carrying the code — on creation, and again if the code changes while no
 * storefront order exists yet. Once a storefront order carries the code it is
 * frozen. The code is uppercased; the sequence is never lowered.
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
        -- refuse a code change once a storefront order number carries the old code
        SELECT inp.*
        FROM inp
        WHERE inp.code ~ '^[A-Z0-9]{2,8}$'
          -- a campaign is run on ONE ordering platform: one linked to the base44
          -- ordering app, or already holding orders from any other source, is
          -- never set up here (the Import page would switch to the storefront
          -- pull and hide the base44 one for a campaign still being fulfilled)
          AND NOT EXISTS (
            SELECT 1 FROM group_buys gb
            WHERE gb.id = inp.group_buy_id AND gb.external_id IS NOT NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM orders o
            WHERE o.group_buy_id = inp.group_buy_id
              AND COALESCE(o.raw_import->>'source', '') <> 'storefront'
          )
          AND NOT EXISTS (
            SELECT 1 FROM storefront.campaign_settings cs
            JOIN storefront.orders o ON o.group_buy_id = cs.group_buy_id
            WHERE cs.group_buy_id = inp.group_buy_id AND cs.code <> inp.code
          )
          -- never publish a campaign members could not pay: at least one active option
          AND (NOT inp.published OR EXISTS (
            SELECT 1 FROM storefront.campaign_payment_options po
            WHERE po.group_buy_id = inp.group_buy_id AND po.active
          ))
      ), taken AS (
        -- highest sequence already used with this code, in ANY year and from
        -- EITHER source: the next storefront number must clear all of them
        SELECT COALESCE(MAX(seq), 0) AS max_seq
        FROM (
          SELECT (regexp_match(o.order_number, '^[0-9]{4}-' || g.code || '-([0-9]+)$'))[1]::int AS seq
          FROM guard g, orders o
          WHERE o.order_number ~ ('^[0-9]{4}-' || g.code || '-[0-9]+$')
          UNION ALL
          SELECT (regexp_match(so.order_number, '^[0-9]{4}-' || g.code || '-([0-9]+)$'))[1]::int AS seq
          FROM guard g, storefront.orders so
          WHERE so.order_number ~ ('^[0-9]{4}-' || g.code || '-[0-9]+$')
        ) s
      )
      INSERT INTO storefront.campaign_settings
        (group_buy_id, code, published, description_md, payment_instructions_md, near_default_rail, insurance_rate_pct, next_order_seq)
      SELECT g.group_buy_id, g.code, g.published, g.description_md, g.payment_instructions_md, g.near_default_rail,
             COALESCE(g.insurance_rate_pct, 1.27), t.max_seq + 1
      FROM guard g, taken t
      ON CONFLICT (group_buy_id) DO UPDATE SET
        code = EXCLUDED.code,
        published = EXCLUDED.published,
        description_md = EXCLUDED.description_md,
        payment_instructions_md = EXCLUDED.payment_instructions_md,
        near_default_rail = EXCLUDED.near_default_rail,
        insurance_rate_pct = EXCLUDED.insurance_rate_pct,
        -- never lowered; raised when the (new) code already has higher numbers out there
        next_order_seq = GREATEST(storefront.campaign_settings.next_order_seq, EXCLUDED.next_order_seq)
      RETURNING group_buy_id, code, published, next_order_seq
    `,
  });
}

export default upsertStorefrontCampaign;
