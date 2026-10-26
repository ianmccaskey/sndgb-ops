-- v_vendor_balances is keyed by MONEY, not by product membership.
--
-- Codex review of 1790102400 (2026-10-26): the view started from
-- v_product_profit, so a vendor existed in it only while it had a product
-- line in the campaign. Add an Other-item adjustment for vendor A, then
-- move A's only campaign product to vendor B (upsertCampaignProduct allows
-- that while no product-attributed payment exists) — A's liability
-- survived in admin_adjustments but A vanished from the Vendors page, from
-- the wallet-coverage owed figure, and from the batch recorder's cap read
-- (which then refused to pay it). The same hole hid a vendor that had only
-- freight-only or Other-items payments.
--
-- A (vendor, campaign) row now exists for every vendor that has a product
-- line, an Other-item adjustment OR a vendor payment in the campaign.
-- Product-derived figures are zero where there is no product line. Column
-- list and types are unchanged for every reader (listVendorBalances,
-- record_vendor_payment_batch, the Vendors page).

DROP VIEW IF EXISTS v_vendor_balances;

CREATE VIEW v_vendor_balances AS
WITH keys AS (
  SELECT v.id AS vendor_id, pp.group_buy_id
  FROM v_product_profit pp
  JOIN vendors v ON v.code = pp.vendor_code
  UNION
  SELECT a.vendor_id, a.group_buy_id
  FROM admin_adjustments a
  WHERE a.group_buy_product_id IS NULL
  UNION
  SELECT vp.vendor_id, vp.group_buy_id
  FROM vendor_payments vp
), prod AS (
  SELECT v.id AS vendor_id, pp.group_buy_id,
         sum(pp.owed_to_vendor_usd) AS product_owed_usd,
         sum(CASE WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits ELSE 0::numeric END) AS product_freight_usd,
         sum(pp.ordered_kits) AS kits_demand
  FROM v_product_profit pp
  JOIN vendors v ON v.code = pp.vendor_code
  GROUP BY v.id, pp.group_buy_id
), vp AS (
  SELECT vendor_payments.vendor_id,
         vendor_payments.group_buy_id,
         sum(vendor_payments.amount_usd) AS paid_usd,
         sum(COALESCE(vendor_payments.kits_qty, 0::numeric)) AS kits_paid,
         sum(COALESCE(vendor_payments.freight_usd, 0::numeric)) AS freight_paid_usd,
         -- payment lines with no product and no freight: the Other-items money
         sum(vendor_payments.amount_usd) FILTER (WHERE vendor_payments.group_buy_product_id IS NULL AND vendor_payments.freight_usd IS NULL) AS other_paid_usd
  FROM vendor_payments
  GROUP BY vendor_payments.vendor_id, vendor_payments.group_buy_id
), df AS (
  SELECT v_direct_freight.vendor_id,
         v_direct_freight.group_buy_id,
         sum(v_direct_freight.direct_freight_usd) AS direct_freight_usd
  FROM v_direct_freight
  GROUP BY v_direct_freight.vendor_id, v_direct_freight.group_buy_id
), oa AS (
  SELECT a.vendor_id,
         a.group_buy_id,
         sum(COALESCE(a.expected_usd, 0::numeric)) AS other_owed_usd
  FROM admin_adjustments a
  WHERE a.group_buy_product_id IS NULL
  GROUP BY a.vendor_id, a.group_buy_id
), t AS (
  SELECT k.vendor_id, k.group_buy_id,
         COALESCE(prod.product_owed_usd, 0::numeric) AS product_owed_usd,
         COALESCE(prod.product_freight_usd, 0::numeric) + COALESCE(df.direct_freight_usd, 0::numeric) AS freight_demand_usd,
         COALESCE(prod.kits_demand, 0::numeric) AS kits_demand,
         COALESCE(vp.paid_usd, 0::numeric) AS paid_usd,
         COALESCE(vp.kits_paid, 0::numeric) AS kits_paid,
         COALESCE(vp.freight_paid_usd, 0::numeric) AS freight_paid_usd,
         COALESCE(df.direct_freight_usd, 0::numeric) AS direct_freight_demand_usd,
         COALESCE(oa.other_owed_usd, 0::numeric) AS other_owed_usd,
         COALESCE(vp.other_paid_usd, 0::numeric) AS other_paid_usd
  FROM keys k
  LEFT JOIN prod ON prod.vendor_id = k.vendor_id AND prod.group_buy_id = k.group_buy_id
  LEFT JOIN vp ON vp.vendor_id = k.vendor_id AND vp.group_buy_id = k.group_buy_id
  LEFT JOIN df ON df.vendor_id = k.vendor_id AND df.group_buy_id = k.group_buy_id
  LEFT JOIN oa ON oa.vendor_id = k.vendor_id AND oa.group_buy_id = k.group_buy_id
)
SELECT t.vendor_id,
       v.code AS vendor_code,
       t.group_buy_id,
       gb.name AS group_buy_name,
       t.product_owed_usd + t.freight_demand_usd + t.other_owed_usd AS owed_usd,
       t.product_owed_usd,
       t.freight_demand_usd,
       t.kits_demand,
       t.paid_usd,
       t.kits_paid,
       t.freight_paid_usd,
       t.product_owed_usd + t.freight_demand_usd + t.other_owed_usd - t.paid_usd AS balance_usd,
       CASE
         WHEN t.paid_usd = 0::numeric THEN 'unpaid'::text
         WHEN t.paid_usd < t.product_owed_usd + t.freight_demand_usd + t.other_owed_usd THEN 'partial'::text
         WHEN t.paid_usd = t.product_owed_usd + t.freight_demand_usd + t.other_owed_usd THEN 'paid'::text
         ELSE 'OVERPAID'::text
       END AS pay_status,
       t.direct_freight_demand_usd,
       t.other_owed_usd,
       t.other_paid_usd
FROM t
JOIN vendors v ON v.id = t.vendor_id
JOIN group_buys gb ON gb.id = t.group_buy_id;

COMMENT ON VIEW v_vendor_balances IS
  'Per vendor and campaign: owed (products + freight + direct freight + Other items) vs paid. Keyed by the union of product lines, Other-item adjustments and vendor payments (1790102500), so a vendor stays visible while money is owed or paid even with no product line.';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102500_vendor_balances_keyed_by_money.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102500_vendor_balances_keyed_by_money.sql');
