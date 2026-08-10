-- The ordering app sells split kits: item quantities can be fractional
-- (e.g. 0.5 of a kit shared across two orders). order_items.qty was INTEGER,
-- so every order containing a fractional line failed its items import — the
-- ::int cast errored. Numeric quantities sum correctly in the demand views
-- (two 0.5 orders = 1 physical unit of vendor demand).
--
-- The dependent view chain must be dropped and recreated around the ALTER:
-- v_group_buy_pnl / v_vendor_balances → v_product_profit → v_moq_progress.

DROP VIEW IF EXISTS v_group_buy_pnl;
DROP VIEW IF EXISTS v_vendor_balances;
DROP VIEW IF EXISTS v_product_profit;
DROP VIEW IF EXISTS v_moq_progress;

ALTER TABLE order_items ALTER COLUMN qty TYPE NUMERIC(10,2);

-- v_moq_progress: as of 1786467900 (tiered vendor cost, both tier fields required)
CREATE VIEW v_moq_progress AS
SELECT
  gbp.id AS group_buy_product_id,
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
  (COALESCE(d.demand_qty, 0) >= gbp.target_moq) AS moq_met,
  CASE WHEN gbp.cost_tier_qty IS NOT NULL AND gbp.cost_tier_price IS NOT NULL
    THEN ROUND(gbp.cost_tier_price * CEIL((COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0))::numeric / gbp.cost_tier_qty), 2)
    ELSE ROUND((COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0)) * gbp.unit_cost_usd, 2)
  END AS vendor_order_value_usd,
  gbp.ordered_from_vendor_at,
  gbp.status
FROM group_buy_products gbp
JOIN group_buys gb ON gb.id = gbp.group_buy_id
JOIN products p ON p.id = gbp.product_id
JOIN vendors v ON v.id = gbp.vendor_id
LEFT JOIN (
  SELECT oi.group_buy_product_id, SUM(oi.qty) AS demand_qty
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status NOT IN ('cancelled','refunded')
  GROUP BY oi.group_buy_product_id
) d ON d.group_buy_product_id = gbp.id
LEFT JOIN (
  SELECT group_buy_product_id, SUM(qty) AS adjustment_qty
  FROM admin_adjustments
  GROUP BY group_buy_product_id
) a ON a.group_buy_product_id = gbp.id;

-- v_product_profit: as of 1786467800 (revenue minus actual vendor cost)
CREATE VIEW v_product_profit AS
SELECT
  m.*,
  gbp.margin_usd,
  gbp.testing_cost_usd,
  gbp.freight_usd,
  CASE WHEN m.final_count > 0 THEN ROUND(gbp.testing_cost_usd / m.final_count, 4) ELSE 0 END AS testing_per_unit_usd,
  CASE WHEN m.final_count > 0 THEN ROUND(gbp.freight_usd / m.final_count, 4) ELSE 0 END AS freight_per_unit_usd,
  CASE WHEN m.final_count > 0
    THEN ROUND((m.final_count * m.gb_price_usd - m.vendor_order_value_usd - gbp.testing_cost_usd - gbp.freight_usd) / m.final_count, 4)
    ELSE 0 END AS net_profit_per_unit_usd,
  CASE WHEN m.final_count > 0
    THEN ROUND(m.final_count * m.gb_price_usd - m.vendor_order_value_usd - gbp.testing_cost_usd - gbp.freight_usd, 2)
    ELSE 0 END AS total_product_profit_usd,
  m.vendor_order_value_usd AS owed_to_vendor_usd,
  ROUND(m.final_count * m.gb_price_usd, 2) AS expected_revenue_usd
FROM v_moq_progress m
JOIN group_buy_products gbp ON gbp.id = m.group_buy_product_id;

-- v_vendor_balances: original definition (base schema)
CREATE VIEW v_vendor_balances AS
SELECT
  v.id AS vendor_id,
  v.code AS vendor_code,
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  SUM(pp.owed_to_vendor_usd) AS owed_usd,
  COALESCE(vp.paid_usd, 0) AS paid_usd,
  SUM(pp.owed_to_vendor_usd) - COALESCE(vp.paid_usd, 0) AS balance_usd,
  CASE
    WHEN COALESCE(vp.paid_usd, 0) = 0 THEN 'unpaid'
    WHEN COALESCE(vp.paid_usd, 0) < SUM(pp.owed_to_vendor_usd) THEN 'partial'
    WHEN COALESCE(vp.paid_usd, 0) = SUM(pp.owed_to_vendor_usd) THEN 'paid'
    ELSE 'OVERPAID'
  END AS pay_status
FROM v_product_profit pp
JOIN vendors v ON v.code = pp.vendor_code
JOIN group_buys gb ON gb.id = pp.group_buy_id
LEFT JOIN (
  SELECT vendor_id, group_buy_id, SUM(amount_usd) AS paid_usd
  FROM vendor_payments
  GROUP BY vendor_id, group_buy_id
) vp ON vp.vendor_id = v.id AND vp.group_buy_id = gb.id
GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd;

-- v_group_buy_pnl: original definition (base schema)
CREATE VIEW v_group_buy_pnl AS
SELECT
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  COALESCE(prod.expected_revenue_usd, 0) AS product_revenue_usd,
  COALESCE(ord.order_count, 0) AS order_count,
  COALESCE(ord.admin_fees_usd, 0) AS admin_fee_revenue_usd,
  COALESCE(ord.shipping_fees_usd, 0) AS shipping_fee_revenue_usd,
  COALESCE(ord.tips_usd, 0) AS tip_revenue_usd,
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0) AS net_profit_usd
FROM group_buys gb
LEFT JOIN (
  SELECT group_buy_id,
    SUM(expected_revenue_usd) AS expected_revenue_usd,
    SUM(total_product_profit_usd) AS product_profit_usd
  FROM v_product_profit
  GROUP BY group_buy_id
) prod ON prod.group_buy_id = gb.id
LEFT JOIN (
  SELECT group_buy_id, COUNT(*) AS order_count,
    SUM(admin_fee_usd) AS admin_fees_usd,
    SUM(shipping_fee_usd) AS shipping_fees_usd,
    SUM(tip_usd) AS tips_usd
  FROM orders
  WHERE status NOT IN ('cancelled','refunded')
  GROUP BY group_buy_id
) ord ON ord.group_buy_id = gb.id
LEFT JOIN (
  SELECT group_buy_id, SUM(total_usd) AS expenses_usd
  FROM expenses
  GROUP BY group_buy_id
) exp ON exp.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(s.label_cost_usd) AS label_costs_usd
  FROM shipments s
  JOIN orders o ON o.id = s.order_id
  GROUP BY o.group_buy_id
) ship ON ship.group_buy_id = gb.id;
