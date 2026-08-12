import { action } from '@uibakery/data';

function addVendorPayment() {
  return action('addVendorPayment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- serialize payments per vendor+campaign: the remaining-demand caps
        -- below read v_vendor_balances and then insert — two concurrent
        -- submits (double-click, two operators) must not both pass the same
        -- remaining figure. hashtext collisions merely over-serialize.
        SELECT pg_advisory_xact_lock(42002, hashtext({{params.vendor_id}}::text || ':' || {{params.group_buy_id}}::text)) AS locked
      ), inp AS (
        -- normalize the optional product id ONCE: every later reference is
        -- a nullable bigint, so a blank product (freight-only money) can
        -- never hit a raw empty-string ::bigint cast regardless of boolean
        -- evaluation order
        SELECT NULLIF({{params.group_buy_product_id}}::text, '')::bigint AS gbp_id
      ), ins AS (
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id)
        SELECT
          {{params.vendor_id}}::bigint,
          {{params.group_buy_id}}::bigint,
          {{params.paid_on}}::date,
          {{params.amount_usd}}::numeric,
          NULLIF({{params.wallet_id}}::text, '')::bigint,
          NULLIF({{params.method}}::text, ''),
          NULLIF({{params.receipt_ref}}::text, ''),
          NULLIF({{params.note}}::text, ''),
          NULLIF({{params.kits_qty}}::text, '')::numeric,
          NULLIF({{params.freight_usd}}::text, '')::numeric,
          inp.gbp_id
        FROM lck, inp
        -- optional breakdown fields: blank = not provided; when provided they
        -- must be clean 2-decimal values (same string-scale rule as every
        -- other quantity boundary)
        WHERE
          -- a provided product must actually be this vendor's product in
          -- this campaign — a stale dropdown must never attribute kits to
          -- someone else's line
          (inp.gbp_id IS NULL OR EXISTS (
            SELECT 1 FROM group_buy_products gbp
            WHERE gbp.id = inp.gbp_id
              AND gbp.vendor_id = {{params.vendor_id}}::bigint
              AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
          ))
          -- kits REQUIRE a product: the per-product ledger is the point, and
          -- unattributed kits would be invisible in it
          AND ({{params.kits_qty}}::text = '' OR ({{params.kits_qty}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
               AND inp.gbp_id IS NOT NULL
               -- can't record paying for more kits than THIS PRODUCT is
               -- currently owed — a typo (1000 for 100) must refuse, not
               -- silently over-close the tracker
               AND ({{params.kits_qty}})::numeric <= (
                 SELECT m.final_count - COALESCE((
                   SELECT SUM(COALESCE(vp2.kits_qty, 0))
                   FROM vendor_payments vp2
                   WHERE vp2.group_buy_product_id = inp.gbp_id
                 ), 0)
                 FROM v_moq_progress m
                 WHERE m.group_buy_product_id = inp.gbp_id
               )))
          AND ({{params.freight_usd}}::text = '' OR ({{params.freight_usd}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
               -- freight is a portion of THIS payment — never more than it
               AND ({{params.freight_usd}})::numeric <= {{params.amount_usd}}::numeric
               -- and never more than the freight still owed to this vendor
               AND ({{params.freight_usd}})::numeric <= (
                 SELECT vb.freight_demand_usd - vb.freight_paid_usd
                 FROM v_vendor_balances vb
                 WHERE vb.vendor_id = {{params.vendor_id}}::bigint
                   AND vb.group_buy_id = {{params.group_buy_id}}::bigint
               )))
        RETURNING id, vendor_id, amount_usd, kits_qty, freight_usd, group_buy_product_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'vendor_payments', ins.id::text, 'insert', {{params.actor}},
             jsonb_build_object('vendor_id', ins.vendor_id, 'amount_usd', ins.amount_usd, 'kits_qty', ins.kits_qty, 'freight_usd', ins.freight_usd, 'group_buy_product_id', ins.group_buy_product_id)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addVendorPayment;
