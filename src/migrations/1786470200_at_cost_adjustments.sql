-- At-cost admin adjustments: kits sold to customers OUTSIDE the group buy
-- at vendor cost + per-kit freight. The kits must join vendor demand (which
-- adjustments already do via final_count → ordered_kits) but stay P&L
-- NEUTRAL — the customer's payment covers exactly what the kits cost.
--
-- Mechanics: pricing='cost' rows get their margin WAIVED in P&L. A +Q
-- adjustment's live contribution is Q×(gb_price − unit_cost − freight/kit);
-- at_cost_margin_usd subtracts precisely that, computed from the SAME live
-- config P&L itself uses, so neutrality holds even if prices change later.
-- The receivable expected_usd = Q×(unit_cost + freight) IS snapshotted at
-- entry (real money agreed with the customer). Tiered-cost products are
-- refused for at-cost rows in addAdjustment (their incremental vendor cost
-- is not Q×unit_cost, so exact neutrality can't be guaranteed).

ALTER TABLE admin_adjustments ADD COLUMN pricing TEXT NOT NULL DEFAULT 'gb'
  CONSTRAINT admin_adjustments_pricing_valid CHECK (pricing IN ('gb', 'cost'));
ALTER TABLE admin_adjustments ADD COLUMN expected_usd NUMERIC(12,2)
  CONSTRAINT admin_adjustments_expected_nonneg CHECK (expected_usd >= 0);
ALTER TABLE admin_adjustments ADD COLUMN received_at timestamptz;
ALTER TABLE admin_adjustments ADD COLUMN received_by TEXT;

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
  -- revenue subtracts the LINEAR at-cost margin: expected_revenue is linear
  -- in final_count, so the at-cost kits always book qty x gb_price there and
  -- waiving qty x (gb − cost − freight) leaves exactly the receivable
  -- (qty x (cost + freight)) in revenue, in every demand state. The cost-side
  -- nonlinearity (CEIL, testing) belongs to NET, not revenue.
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0) + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0) + COALESCE(spl.split_fees_usd, 0) - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0) - COALESCE(adjb.adj_both_usd, 0) - COALESCE(atc.revenue_waiver_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0) + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0) + COALESCE(spl.split_fees_usd, 0) - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0) - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0) - COALESCE(adjb.adj_both_usd, 0) - COALESCE(dfr.direct_freight_usd, 0) - COALESCE(atc.at_cost_margin_usd, 0) AS net_profit_usd,
  COALESCE(dfr.direct_freight_usd, 0) AS direct_freight_usd,
  COALESCE(spl.split_fees_usd, 0) AS split_fees_usd,
  COALESCE(atc.at_cost_margin_usd, 0) AS at_cost_margin_usd
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
  -- only GB-priced adjustments: at-cost rows have their own margin waiver
  SELECT gbp.group_buy_id, SUM(a.qty * gbp.gb_price_usd) AS adj_both_usd
  FROM admin_adjustments a
  JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
  WHERE a.beneficiary = 'both' AND a.pricing = 'gb'
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
) spl ON spl.group_buy_id = gb.id
LEFT JOIN (
  -- margin waived on at-cost sales: EXACTLY the kits' incremental P&L
  -- contribution in every demand state, so their net effect is always zero:
  --  * non-cost baseline still positive (final_count − at_cost_qty > 0):
  --    the increment is linear — qty × (GB price − unit cost − per-kit
  --    freight); whole at-cost qtys are CEIL-transparent for any baseline,
  --    and the flat testing cost is charged with or without the rows;
  --  * baseline <= 0 (real demand later collapsed): without the at-cost
  --    rows the product would contribute NOTHING (final_count <= 0 zeroes
  --    v_product_profit), so the increment is the product's ENTIRE
  --    total_product_profit_usd — waive exactly that, which also covers
  --    fractional/negative baselines, CEIL steps, and testing.
  SELECT t.group_buy_id,
         SUM(t.net_waiver_usd) AS at_cost_margin_usd,
         SUM(t.revenue_waiver_usd) AS revenue_waiver_usd
  FROM (
    SELECT gbp.group_buy_id,
           SUM(a.qty) * (gbp.gb_price_usd - gbp.unit_cost_usd - gbp.freight_usd) AS revenue_waiver_usd,
           CASE WHEN pp.final_count - SUM(a.qty) > 0
                THEN SUM(a.qty) * (gbp.gb_price_usd - gbp.unit_cost_usd - gbp.freight_usd)
                ELSE pp.total_product_profit_usd
           END AS net_waiver_usd
    FROM admin_adjustments a
    JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
    JOIN v_product_profit pp ON pp.group_buy_product_id = gbp.id
    WHERE a.pricing = 'cost'
    GROUP BY gbp.group_buy_id, gbp.id, gbp.gb_price_usd, gbp.unit_cost_usd, gbp.freight_usd, pp.final_count, pp.total_product_profit_usd
  ) t
  GROUP BY t.group_buy_id
) atc ON atc.group_buy_id = gb.id;
