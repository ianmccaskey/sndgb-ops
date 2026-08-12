-- Vendor payments gain an optional breakdown: how many kits the payment
-- covers and how much of it is freight. v_vendor_balances gains the demand
-- side (total kits = final counts, total freight = configured freight per
-- product) and the paid side (sums of the breakdowns), so each vendor shows
-- kits/freight remaining as payments are recorded.
--
-- owed_usd now INCLUDES freight (product cost + freight): real vendor
-- payments cover both, and comparing freight-inclusive payments against a
-- cost-only owed figure would misread as OVERPAID. product_owed_usd keeps
-- the cost-only figure visible.

ALTER TABLE vendor_payments ADD COLUMN kits_qty NUMERIC(10,2) CHECK (kits_qty IS NULL OR kits_qty > 0);
ALTER TABLE vendor_payments ADD COLUMN freight_usd NUMERIC(12,2) CHECK (freight_usd IS NULL OR freight_usd >= 0);

-- freight is the PORTION OF THIS PAYMENT that covers freight — it cannot
-- exceed the payment itself, or the summed freight_paid figure lies about
-- money that was never sent. (kits_qty has no equivalent monetary bound:
-- per-kit cost varies by product/tier, so kits × price can't be checked
-- against the amount here.)
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_freight_within_amount
  CHECK (freight_usd IS NULL OR freight_usd <= amount_usd);

DROP VIEW IF EXISTS v_vendor_balances;

-- freight only becomes owed when the product actually has kits to buy
-- (final_count > 0) — a configured-but-unsold product must not create debt.
CREATE VIEW v_vendor_balances AS
SELECT
  v.id AS vendor_id,
  v.code AS vendor_code,
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) AS owed_usd,
  SUM(pp.owed_to_vendor_usd) AS product_owed_usd,
  SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) AS freight_demand_usd,
  SUM(pp.final_count) AS kits_demand,
  COALESCE(vp.paid_usd, 0) AS paid_usd,
  COALESCE(vp.kits_paid, 0) AS kits_paid,
  COALESCE(vp.freight_paid_usd, 0) AS freight_paid_usd,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) - COALESCE(vp.paid_usd, 0) AS balance_usd,
  CASE
    WHEN COALESCE(vp.paid_usd, 0) = 0 THEN 'unpaid'
    WHEN COALESCE(vp.paid_usd, 0) < SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) THEN 'partial'
    WHEN COALESCE(vp.paid_usd, 0) = SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) THEN 'paid'
    ELSE 'OVERPAID'
  END AS pay_status
FROM v_product_profit pp
JOIN vendors v ON v.code = pp.vendor_code
JOIN group_buys gb ON gb.id = pp.group_buy_id
LEFT JOIN (
  SELECT vendor_id, group_buy_id,
         SUM(amount_usd) AS paid_usd,
         SUM(COALESCE(kits_qty, 0)) AS kits_paid,
         SUM(COALESCE(freight_usd, 0)) AS freight_paid_usd
  FROM vendor_payments
  GROUP BY vendor_id, group_buy_id
) vp ON vp.vendor_id = v.id AND vp.group_buy_id = gb.id
GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd, vp.kits_paid, vp.freight_paid_usd;
