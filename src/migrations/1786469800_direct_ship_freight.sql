-- Direct-ship freight: vendors that ship kits straight to customers charge
-- freight per BOX (Lobster: $125 per box of 30 kits). This is an INTERNAL
-- cost — never billed to the customer — owed to the vendor on top of
-- product cost, and a P&L deduction.
--
-- Per campaign product: direct_freight_usd (rate per box, 0 = no charge)
-- and direct_box_kits (box capacity). Boxes are computed PER ORDER LINE —
-- each customer's direct shipment packs separately, so a 40-kit line needs
-- 2 boxes even though two 30-kit lines in different orders need 1 each.

ALTER TABLE group_buy_products ADD COLUMN direct_freight_usd NUMERIC(12,2) NOT NULL DEFAULT 0
  CONSTRAINT group_buy_products_direct_freight_nonneg CHECK (direct_freight_usd >= 0);
ALTER TABLE group_buy_products ADD COLUMN direct_box_kits INTEGER NOT NULL DEFAULT 30
  CONSTRAINT group_buy_products_direct_box_positive CHECK (direct_box_kits > 0);

-- Backfill: every Lobster product carries $125/box of 30 (confirmed by Ian).
UPDATE group_buy_products SET direct_freight_usd = 125.00 WHERE vendor_id = 2;

-- One row per campaign product that has direct-ship demand and a rate:
-- boxes and dollars, from ACTIVE orders' direct-ship lines at effective qty.
CREATE VIEW v_direct_freight AS
SELECT gbp.id AS group_buy_product_id,
       gbp.group_buy_id,
       gbp.vendor_id,
       v.code AS vendor_code,
       p.sku_code,
       COUNT(*) AS direct_lines,
       SUM(CEIL(COALESCE(oi.qty_override, oi.qty) / gbp.direct_box_kits::numeric)) AS boxes,
       SUM(CEIL(COALESCE(oi.qty_override, oi.qty) / gbp.direct_box_kits::numeric)) * gbp.direct_freight_usd AS direct_freight_usd
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
JOIN vendors v ON v.id = gbp.vendor_id
JOIN products p ON p.id = gbp.product_id
WHERE oi.direct_ship
  AND oi.removed_at IS NULL
  AND COALESCE(oi.qty_override, oi.qty) > 0
  AND o.status NOT IN ('cancelled', 'refunded')
  AND gbp.direct_freight_usd > 0
GROUP BY gbp.id, gbp.group_buy_id, gbp.vendor_id, v.code, p.sku_code, gbp.direct_freight_usd;

-- Vendor balances: direct-ship freight joins kit freight in what we owe.
-- freight_demand_usd (and owed/balance/pay_status) now include it, so the
-- vendor card's "Freight left" and the payment cap follow automatically;
-- direct_freight_demand_usd is appended for display breakdowns.
CREATE OR REPLACE VIEW v_vendor_balances AS
SELECT v.id AS vendor_id,
  v.code AS vendor_code,
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) + COALESCE(df.direct_freight_usd, 0) AS owed_usd,
  SUM(pp.owed_to_vendor_usd) AS product_owed_usd,
  SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) + COALESCE(df.direct_freight_usd, 0) AS freight_demand_usd,
  SUM(pp.final_count) AS kits_demand,
  COALESCE(vp.paid_usd, 0) AS paid_usd,
  COALESCE(vp.kits_paid, 0) AS kits_paid,
  COALESCE(vp.freight_paid_usd, 0) AS freight_paid_usd,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) + COALESCE(df.direct_freight_usd, 0) - COALESCE(vp.paid_usd, 0) AS balance_usd,
  CASE
    WHEN COALESCE(vp.paid_usd, 0) = 0 THEN 'unpaid'
    WHEN COALESCE(vp.paid_usd, 0) < (SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) + COALESCE(df.direct_freight_usd, 0)) THEN 'partial'
    WHEN COALESCE(vp.paid_usd, 0) = (SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END) + COALESCE(df.direct_freight_usd, 0)) THEN 'paid'
    ELSE 'OVERPAID'
  END AS pay_status,
  COALESCE(df.direct_freight_usd, 0) AS direct_freight_demand_usd
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
LEFT JOIN (
  SELECT vendor_id, group_buy_id, SUM(direct_freight_usd) AS direct_freight_usd
  FROM v_direct_freight
  GROUP BY vendor_id, group_buy_id
) df ON df.vendor_id = v.id AND df.group_buy_id = gb.id
GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd, vp.kits_paid, vp.freight_paid_usd, df.direct_freight_usd;

-- P&L: direct-ship freight is a new internal cost line. Kit freight is
-- already inside product_profit_usd (per-kit rate in v_product_profit);
-- direct freight is order-driven so it subtracts separately in net.
CREATE OR REPLACE VIEW v_group_buy_pnl AS
SELECT gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  COALESCE(prod.expected_revenue_usd, 0) AS product_revenue_usd,
  COALESCE(ord.order_count, 0) AS order_count,
  COALESCE(ord.admin_fees_usd, 0) AS admin_fee_revenue_usd,
  COALESCE(ord.shipping_fees_usd, 0) AS shipping_fee_revenue_usd,
  COALESCE(ord.insurance_usd, 0) AS insurance_revenue_usd,
  COALESCE(ord.tips_usd, 0) AS tip_revenue_usd,
  COALESCE(cmp.comps_usd, 0) AS comps_usd,
  COALESCE(cred.credits_usd, 0) AS credits_usd,
  COALESCE(wo.writeoffs_usd, 0) AS writeoffs_usd,
  COALESCE(adjb.adj_both_usd, 0) AS adj_both_usd,
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0) + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0) - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0) - COALESCE(adjb.adj_both_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0) + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0) - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0) - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0) - COALESCE(adjb.adj_both_usd, 0) - COALESCE(dfr.direct_freight_usd, 0) AS net_profit_usd,
  COALESCE(dfr.direct_freight_usd, 0) AS direct_freight_usd
FROM group_buys gb
LEFT JOIN (
  SELECT v_product_profit.group_buy_id,
         SUM(v_product_profit.expected_revenue_usd) AS expected_revenue_usd,
         SUM(v_product_profit.total_product_profit_usd) AS product_profit_usd
  FROM v_product_profit
  GROUP BY v_product_profit.group_buy_id
) prod ON prod.group_buy_id = gb.id
LEFT JOIN (
  SELECT orders.group_buy_id,
         COUNT(*) AS order_count,
         SUM(COALESCE(orders.admin_fee_override_usd, orders.admin_fee_usd)) AS admin_fees_usd,
         SUM(COALESCE(orders.shipping_fee_override_usd, orders.shipping_fee_usd)) AS shipping_fees_usd,
         SUM(COALESCE(orders.shipping_insurance_override_usd, orders.shipping_insurance_usd)) AS insurance_usd,
         SUM(COALESCE(orders.tip_override_usd, orders.tip_usd)) AS tips_usd
  FROM orders
  WHERE orders.status NOT IN ('cancelled', 'refunded')
  GROUP BY orders.group_buy_id
) ord ON ord.group_buy_id = gb.id
LEFT JOIN (
  SELECT expenses.group_buy_id, SUM(expenses.total_usd) AS expenses_usd
  FROM expenses
  GROUP BY expenses.group_buy_id
) exp ON exp.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(s.label_cost_usd) AS label_costs_usd
  FROM shipments s
  JOIN orders o ON o.id = s.order_id
  GROUP BY o.group_buy_id
) ship ON ship.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id,
         SUM(LEAST(oi.comp_qty, CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) * oi.unit_price_usd) AS comps_usd
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status NOT IN ('cancelled', 'refunded') AND oi.comp_qty > 0
  GROUP BY o.group_buy_id
) cmp ON cmp.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(oc.amount_usd) AS credits_usd
  FROM order_credits oc
  JOIN orders o ON o.id = oc.order_id
  WHERE o.status NOT IN ('cancelled', 'refunded')
  GROUP BY o.group_buy_id
) cred ON cred.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(w.amount_usd) AS writeoffs_usd
  FROM order_writeoffs w
  JOIN orders o ON o.id = w.order_id
  WHERE o.status NOT IN ('cancelled', 'refunded')
  GROUP BY o.group_buy_id
) wo ON wo.group_buy_id = gb.id
LEFT JOIN (
  SELECT gbp.group_buy_id, SUM(a.qty * gbp.gb_price_usd) AS adj_both_usd
  FROM admin_adjustments a
  JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
  WHERE a.beneficiary = 'both'
  GROUP BY gbp.group_buy_id
) adjb ON adjb.group_buy_id = gb.id
LEFT JOIN (
  SELECT group_buy_id, SUM(direct_freight_usd) AS direct_freight_usd
  FROM v_direct_freight
  GROUP BY group_buy_id
) dfr ON dfr.group_buy_id = gb.id;
