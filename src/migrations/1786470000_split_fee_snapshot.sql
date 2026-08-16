-- Split fees are ORDER-TIME money, not live config: the charged fee is
-- snapshotted onto the order line, so later edits to the campaign
-- product's split_fee_usd can never rewrite historical order
-- decompositions, the push total-repair target, or P&L revenue.
--
-- The snapshot is keyed to the UPSTREAM qty (what the ordering app
-- charged): imports set it when the line's qty changes (current rate if
-- fractional, else 0); local qty overrides never touch it.

ALTER TABLE order_items ADD COLUMN split_fee_usd NUMERIC(12,2) NOT NULL DEFAULT 0
  CONSTRAINT order_items_split_fee_nonneg CHECK (split_fee_usd >= 0);

-- Backfill from the current rates (the only rate that has ever existed:
-- $5 on Adamax, verified against every split order's $5.00 total residual).
UPDATE order_items oi SET split_fee_usd = gbp.split_fee_usd
FROM group_buy_products gbp
WHERE gbp.id = oi.group_buy_product_id
  AND oi.qty % 1 <> 0
  AND gbp.split_fee_usd > 0;

-- P&L reads the snapshots, not the config.
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
  SELECT o.group_buy_id, SUM(oi.split_fee_usd) AS split_fees_usd
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status NOT IN ('cancelled', 'refunded')
    AND oi.removed_at IS NULL
    AND oi.split_fee_usd > 0
  GROUP BY o.group_buy_id
) spl ON spl.group_buy_id = gb.id;
