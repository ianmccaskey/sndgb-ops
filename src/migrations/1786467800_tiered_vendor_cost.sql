-- Real tiered (step) vendor cost, e.g. "COA - Adamax" costs $50 per 4 units.
-- target_moq expresses a minimum; this expresses a per-N-units cost that
-- target_moq / flat unit_cost can't. When cost_tier_qty is set, a line's
-- vendor cost is cost_tier_price * ceil(final_count / cost_tier_qty); otherwise
-- it stays the flat unit_cost_usd * final_count.
ALTER TABLE group_buy_products ADD COLUMN IF NOT EXISTS cost_tier_qty INTEGER CHECK (cost_tier_qty IS NULL OR cost_tier_qty > 0);
ALTER TABLE group_buy_products ADD COLUMN IF NOT EXISTS cost_tier_price NUMERIC(12,2) CHECK (cost_tier_price IS NULL OR cost_tier_price >= 0);
-- A tier is all-or-nothing: both fields set, or neither. A half-set tier would
-- make the vendor-cost CASE return NULL and silently zero out vendor liability.
ALTER TABLE group_buy_products DROP CONSTRAINT IF EXISTS cost_tier_both_or_neither;
ALTER TABLE group_buy_products ADD CONSTRAINT cost_tier_both_or_neither CHECK ((cost_tier_qty IS NULL) = (cost_tier_price IS NULL));

-- Recompute vendor cost with the tier. Same output columns/order as before, so
-- CREATE OR REPLACE keeps the dependent views (v_product_profit → v_vendor_balances,
-- v_group_buy_pnl) valid. Only vendor_order_value_usd's expression changes.
CREATE OR REPLACE VIEW v_moq_progress AS
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

-- Profit becomes revenue - actual vendor cost - testing - freight. For flat
-- lines this equals the old margin-based figure exactly; for tiered lines it
-- uses the real stepped cost. owed_to_vendor is just the (already tiered)
-- vendor_order_value_usd from v_moq_progress.
CREATE OR REPLACE VIEW v_product_profit AS
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
