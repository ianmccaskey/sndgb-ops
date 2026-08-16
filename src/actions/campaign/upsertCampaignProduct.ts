import { action } from '@uibakery/data';

/**
 * The update path refuses a VENDOR change once product-attributed vendor
 * payments exist for the line: per-product kit payments are summed by
 * group_buy_product_id, so silently moving the product to another vendor
 * would count old-vendor payments as the new vendor's progress (and eat its
 * kit allowance). Zero rows = refused; delete/reassign the payments first.
 */
function upsertCampaignProduct() {
  return action('upsertCampaignProduct', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO group_buy_products
        (group_buy_id, product_id, vendor_id, unit_cost_usd, margin_usd, target_moq,
         testing_cost_usd, freight_usd, qty_cap, cost_tier_qty, cost_tier_price,
         direct_freight_usd, direct_box_kits, split_fee_usd)
      VALUES (
        {{params.group_buy_id}}::bigint,
        {{params.product_id}}::bigint,
        {{params.vendor_id}}::bigint,
        {{params.unit_cost_usd}}::numeric,
        {{params.margin_usd}}::numeric,
        {{params.target_moq}}::int,
        {{params.testing_cost_usd}}::numeric,
        {{params.freight_usd}}::numeric,
        NULLIF({{params.qty_cap}}::text, '')::int,
        NULLIF({{params.cost_tier_qty}}::text, '')::int,
        NULLIF({{params.cost_tier_price}}::text, '')::numeric,
        COALESCE(NULLIF({{params.direct_freight_usd}}::text, '')::numeric, 0),
        COALESCE(NULLIF({{params.direct_box_kits}}::text, '')::int, 30),
        COALESCE(NULLIF({{params.split_fee_usd}}::text, '')::numeric, 0)
      )
      ON CONFLICT (group_buy_id, product_id) DO UPDATE SET
        vendor_id = EXCLUDED.vendor_id,
        unit_cost_usd = EXCLUDED.unit_cost_usd,
        margin_usd = EXCLUDED.margin_usd,
        target_moq = EXCLUDED.target_moq,
        testing_cost_usd = EXCLUDED.testing_cost_usd,
        freight_usd = EXCLUDED.freight_usd,
        qty_cap = EXCLUDED.qty_cap,
        cost_tier_qty = EXCLUDED.cost_tier_qty,
        cost_tier_price = EXCLUDED.cost_tier_price,
        direct_freight_usd = EXCLUDED.direct_freight_usd,
        direct_box_kits = EXCLUDED.direct_box_kits,
        split_fee_usd = EXCLUDED.split_fee_usd
      WHERE group_buy_products.vendor_id = EXCLUDED.vendor_id
         OR NOT EXISTS (
           SELECT 1 FROM vendor_payments vp
           WHERE vp.group_buy_product_id = group_buy_products.id
         )
      RETURNING id
    `,
  });
}

export default upsertCampaignProduct;
