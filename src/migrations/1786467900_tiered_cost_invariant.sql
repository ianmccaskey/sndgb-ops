-- Enforce that a cost tier is all-or-nothing. A half-set tier (qty without
-- price, or vice-versa) would make v_moq_progress's vendor-cost CASE return
-- NULL and silently zero out vendor liability in balances and P&L.
ALTER TABLE group_buy_products DROP CONSTRAINT IF EXISTS cost_tier_both_or_neither;
ALTER TABLE group_buy_products ADD CONSTRAINT cost_tier_both_or_neither CHECK ((cost_tier_qty IS NULL) = (cost_tier_price IS NULL));

-- Belt-and-suspenders: only use tiered math when BOTH fields are present, so a
-- bad row (should be impossible under the constraint) can never yield NULL cost.
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
