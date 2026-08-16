-- Freight is a PER-KIT rate, not a flat per-product-line cost.
--
-- group_buy_products.freight_usd was being added ONCE per product line in
-- v_vendor_balances / v_product_profit / the wallet-coverage action, but the
-- operators enter it as a per-kit rate (Uther: Tesa 10 at 4.20/kit and
-- Adamax at 4.25/kit showed a combined freight demand of $8.45 instead of
-- 742×4.20 + 139×4.25 = $3,707.15). Every consumer now multiplies the rate
-- by final_count; a line with no kits still contributes zero freight.
--
-- P&L follows automatically: v_group_buy_pnl reads freight only through
-- v_product_profit.total_product_profit_usd. Testing cost stays flat per
-- line (it is genuinely a one-time per-product lab fee).

-- A negative freight rate multiplied by kit count would ERASE vendor
-- liability at scale (a -4.25 typo on 742 kits hides $3,153.50 owed), so
-- the rate is constrained non-negative at the table — every entry path
-- (campaign form, direct SQL) fails loudly instead of storing it.
ALTER TABLE group_buy_products
  ADD CONSTRAINT group_buy_products_freight_nonneg CHECK (freight_usd >= 0);

CREATE OR REPLACE VIEW v_product_profit AS
SELECT m.group_buy_product_id,
  m.group_buy_id,
  m.group_buy_name,
  m.sku_code,
  m.product_name,
  m.mass_label,
  m.vendor_code,
  m.unit_cost_usd,
  m.gb_price_usd,
  m.target_moq,
  m.demand_qty,
  m.adjustment_qty,
  m.final_count,
  m.moq_met,
  m.vendor_order_value_usd,
  m.ordered_from_vendor_at,
  m.status,
  gbp.margin_usd,
  gbp.testing_cost_usd,
  gbp.freight_usd,
  CASE WHEN m.final_count > 0 THEN ROUND(gbp.testing_cost_usd / m.final_count, 4) ELSE 0 END AS testing_per_unit_usd,
  -- freight_usd IS the per-kit rate now
  CASE WHEN m.final_count > 0 THEN gbp.freight_usd ELSE 0 END AS freight_per_unit_usd,
  CASE WHEN m.final_count > 0 THEN ROUND((m.final_count * m.gb_price_usd - m.vendor_order_value_usd - gbp.testing_cost_usd - gbp.freight_usd * m.final_count) / m.final_count, 4) ELSE 0 END AS net_profit_per_unit_usd,
  CASE WHEN m.final_count > 0 THEN ROUND(m.final_count * m.gb_price_usd - m.vendor_order_value_usd - gbp.testing_cost_usd - gbp.freight_usd * m.final_count, 2) ELSE 0 END AS total_product_profit_usd,
  -- final_count can go negative via admin adjustments; a negative count
  -- must never read as the vendor owing US product money — it would hide
  -- real payable balances downstream (vendor cards, wallet coverage)
  CASE WHEN m.final_count > 0 THEN m.vendor_order_value_usd ELSE 0 END AS owed_to_vendor_usd,
  ROUND(m.final_count * m.gb_price_usd, 2) AS expected_revenue_usd
FROM v_moq_progress m
JOIN group_buy_products gbp ON gbp.id = m.group_buy_product_id;

CREATE OR REPLACE VIEW v_vendor_balances AS
SELECT v.id AS vendor_id,
  v.code AS vendor_code,
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) AS owed_usd,
  SUM(pp.owed_to_vendor_usd) AS product_owed_usd,
  SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) AS freight_demand_usd,
  SUM(pp.final_count) AS kits_demand,
  COALESCE(vp.paid_usd, 0) AS paid_usd,
  COALESCE(vp.kits_paid, 0) AS kits_paid,
  COALESCE(vp.freight_paid_usd, 0) AS freight_paid_usd,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) - COALESCE(vp.paid_usd, 0) AS balance_usd,
  CASE
    WHEN COALESCE(vp.paid_usd, 0) = 0 THEN 'unpaid'
    WHEN COALESCE(vp.paid_usd, 0) < (SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END)) THEN 'partial'
    WHEN COALESCE(vp.paid_usd, 0) = (SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END)) THEN 'paid'
    ELSE 'OVERPAID'
  END AS pay_status
FROM v_product_profit pp
JOIN vendors v ON v.code = pp.vendor_code
JOIN group_buys gb ON gb.id = pp.group_buy_id
LEFT JOIN (
  SELECT vendor_payments.vendor_id,
         vendor_payments.group_buy_id,
         SUM(vendor_payments.amount_usd) AS paid_usd,
         SUM(COALESCE(vendor_payments.kits_qty, 0)) AS kits_paid,
         SUM(COALESCE(vendor_payments.freight_usd, 0)) AS freight_paid_usd
  FROM vendor_payments
  GROUP BY vendor_payments.vendor_id, vendor_payments.group_buy_id
) vp ON vp.vendor_id = v.id AND vp.group_buy_id = gb.id
GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd, vp.kits_paid, vp.freight_paid_usd;
