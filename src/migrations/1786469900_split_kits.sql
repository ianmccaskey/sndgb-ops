-- Split (half) kits: some products (Adamax) are offered as half kits —
-- the customer pays half the kit price PLUS a flat split fee ($5), which
-- the ordering app already folds into the order total (verified: every
-- split order's total carries an exact $5.00 residual over items + fees).
--
-- This migration makes the money legible and the vendor side whole-kit:
--  * group_buy_products.split_fee_usd — the per-split-line fee rate
--    (backfilled $5 on Adamax); a line is "split" when its effective qty
--    has a fractional part.
--  * Vendor ordering rounds UP: you can only buy whole kits, so the flat
--    cost branch and the kit-freight base use ordered_kits =
--    CEIL(final_count) (positive counts only; the tiered branch already
--    rounds to whole tiers). Today every final_count is integral, so no
--    live money moves until an odd half kit appears.
--  * P&L gains split-fee revenue (it was silently missing: order totals
--    include the fee but P&L revenue is rebuilt from items + named fees).

ALTER TABLE group_buy_products ADD COLUMN split_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0
  CONSTRAINT group_buy_products_split_fee_nonneg CHECK (split_fee_usd >= 0);

UPDATE group_buy_products gbp SET split_fee_usd = 5.00
FROM products p WHERE p.id = gbp.product_id AND p.sku_code ILIKE 'adamax%';

CREATE OR REPLACE VIEW v_moq_progress AS
SELECT gbp.id AS group_buy_product_id,
  gbp.group_buy_id,
  gb.name AS group_buy_name,
  p.sku_code,
  p.name AS product_name,
  p.mass_label,
  v.code AS vendor_code,
  gbp.unit_cost_usd,
  gbp.gb_price_usd,
  gbp.target_moq,
  COALESCE(d.demand_qty, 0) AS demand_qty,
  COALESCE(a.adjustment_qty, 0) AS adjustment_qty,
  COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) AS final_count,
  COALESCE(d.demand_qty, 0) >= gbp.target_moq::numeric AS moq_met,
  CASE
    WHEN gbp.cost_tier_qty IS NOT NULL AND gbp.cost_tier_price IS NOT NULL
      THEN ROUND(gbp.cost_tier_price * CEIL((COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0)) / gbp.cost_tier_qty::numeric), 2)
    -- flat cost buys WHOLE kits: half-kit demand rounds up to the kit
    ELSE ROUND((CASE WHEN COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) > 0
                     THEN CEIL(COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0))
                     ELSE COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) END) * gbp.unit_cost_usd, 2)
  END AS vendor_order_value_usd,
  gbp.ordered_from_vendor_at,
  gbp.status,
  -- whole kits to order from the vendor (negative counts pass through for
  -- the downstream zero-clamps to handle)
  CASE WHEN COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) > 0
       THEN CEIL(COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0))
       ELSE COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) END AS ordered_kits
FROM group_buy_products gbp
JOIN group_buys gb ON gb.id = gbp.group_buy_id
JOIN products p ON p.id = gbp.product_id
JOIN vendors v ON v.id = gbp.vendor_id
LEFT JOIN (
  SELECT oi.group_buy_product_id,
         SUM(CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) AS demand_qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status NOT IN ('cancelled', 'refunded')
  GROUP BY oi.group_buy_product_id
) d ON d.group_buy_product_id = gbp.id
LEFT JOIN (
  SELECT admin_adjustments.group_buy_product_id, SUM(admin_adjustments.qty) AS adjustment_qty
  FROM admin_adjustments
  GROUP BY admin_adjustments.group_buy_product_id
) a ON a.group_buy_product_id = gbp.id;

-- Kit freight is paid on kits BOUGHT (whole), not kits sold (halves):
-- profit and the freight base switch to ordered_kits. Revenue stays on
-- final_count — customers pay for exactly what they ordered.
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
  CASE WHEN m.final_count > 0 THEN gbp.freight_usd ELSE 0 END AS freight_per_unit_usd,
  CASE WHEN m.final_count > 0 THEN ROUND((m.final_count * m.gb_price_usd - m.vendor_order_value_usd - gbp.testing_cost_usd - gbp.freight_usd * m.ordered_kits) / m.final_count, 4) ELSE 0 END AS net_profit_per_unit_usd,
  CASE WHEN m.final_count > 0 THEN ROUND(m.final_count * m.gb_price_usd - m.vendor_order_value_usd - gbp.testing_cost_usd - gbp.freight_usd * m.ordered_kits, 2) ELSE 0 END AS total_product_profit_usd,
  CASE WHEN m.final_count > 0 THEN m.vendor_order_value_usd ELSE 0 END AS owed_to_vendor_usd,
  ROUND(m.final_count * m.gb_price_usd, 2) AS expected_revenue_usd,
  m.ordered_kits
FROM v_moq_progress m
JOIN group_buy_products gbp ON gbp.id = m.group_buy_product_id;

CREATE OR REPLACE VIEW v_vendor_balances AS
SELECT v.id AS vendor_id,
  v.code AS vendor_code,
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.ordered_kits ELSE 0 END) + COALESCE(df.direct_freight_usd, 0) AS owed_usd,
  SUM(pp.owed_to_vendor_usd) AS product_owed_usd,
  SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.ordered_kits ELSE 0 END) + COALESCE(df.direct_freight_usd, 0) AS freight_demand_usd,
  SUM(pp.ordered_kits) AS kits_demand,
  COALESCE(vp.paid_usd, 0) AS paid_usd,
  COALESCE(vp.kits_paid, 0) AS kits_paid,
  COALESCE(vp.freight_paid_usd, 0) AS freight_paid_usd,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.ordered_kits ELSE 0 END) + COALESCE(df.direct_freight_usd, 0) - COALESCE(vp.paid_usd, 0) AS balance_usd,
  CASE
    WHEN COALESCE(vp.paid_usd, 0) = 0 THEN 'unpaid'
    WHEN COALESCE(vp.paid_usd, 0) < (SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.ordered_kits ELSE 0 END) + COALESCE(df.direct_freight_usd, 0)) THEN 'partial'
    WHEN COALESCE(vp.paid_usd, 0) = (SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.ordered_kits ELSE 0 END) + COALESCE(df.direct_freight_usd, 0)) THEN 'paid'
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

-- P&L: split fees are real revenue the order totals already carry — count
-- them (they were previously invisible to the P&L rebuild).
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
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0) + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0) + COALESCE(spl.split_fees_usd, 0) - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0) - COALESCE(adjb.adj_both_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0) + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0) + COALESCE(spl.split_fees_usd, 0) - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0) - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0) - COALESCE(adjb.adj_both_usd, 0) - COALESCE(dfr.direct_freight_usd, 0) AS net_profit_usd,
  COALESCE(dfr.direct_freight_usd, 0) AS direct_freight_usd,
  COALESCE(spl.split_fees_usd, 0) AS split_fees_usd
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
) dfr ON dfr.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(gbp.split_fee_usd) AS split_fees_usd
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
  WHERE o.status NOT IN ('cancelled', 'refunded')
    AND oi.removed_at IS NULL
    AND COALESCE(oi.qty_override, oi.qty) % 1 <> 0
    AND gbp.split_fee_usd > 0
  GROUP BY o.group_buy_id
) spl ON spl.group_buy_id = gb.id;
