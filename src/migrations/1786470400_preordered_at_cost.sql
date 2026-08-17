-- PRE-ORDERED at-cost sales: kits sold to an outside customer at vendor
-- cost + freight where the vendor order was ALREADY placed and paid from
-- the wallet (e.g. floating stock). Unlike a normal at-cost adjustment:
--   * NO demand effect — the kits are bought; nothing joins what we still
--     need to order from the vendor (v_moq_progress excludes these rows);
--   * NO P&L effect at all — final_count never moves, so no revenue, cost,
--     freight, or testing enters P&L, and no margin waiver is needed
--     (the at_cost waiver explicitly excludes preordered rows);
--   * the RECEIVABLE is identical — expected_usd = qty x (cost + freight)
--     snapshotted at entry, awaiting/mark-received lifecycle unchanged,
--     and it feeds the Planner's expected-payments source (money that
--     belongs to the wallet and is on its way back).

ALTER TABLE admin_adjustments ADD COLUMN preordered BOOLEAN NOT NULL DEFAULT false;

-- Demand root: preordered at-cost rows carry qty for the record (what was
-- sold) but contribute ZERO to final_count.
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
    ELSE ROUND((CASE WHEN COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) > 0
                     THEN CEIL(COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0))
                     ELSE COALESCE(d.demand_qty, 0) + COALESCE(a.adjustment_qty, 0) END) * gbp.unit_cost_usd, 2)
  END AS vendor_order_value_usd,
  gbp.ordered_from_vendor_at,
  gbp.status,
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
  -- pre-ordered at-cost kits are ALREADY BOUGHT: they must not re-enter
  -- what still needs ordering from the vendor
  WHERE NOT (admin_adjustments.pricing = 'cost' AND admin_adjustments.preordered)
  GROUP BY admin_adjustments.group_buy_product_id
) a ON a.group_buy_product_id = gbp.id;
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
  -- at-cost waivers, ANCHORED to the snapshotted receivable (expected_usd —
  -- the money actually agreed with the outside customer), so later edits to
  -- the product's price/cost/freight can never rewrite the sale's revenue:
  --  * revenue: expected_revenue is LINEAR in final_count, so the at-cost
  --    kits always book qty × gb_price there — waiving qty × gb_price −
  --    expected leaves exactly the receivable in revenue, in every state;
  --  * net, baseline > 0: same waiver — at entry expected = qty × (cost +
  --    freight), making the sale exactly neutral; if vendor economics are
  --    later EDITED, net honestly shows the real gain/loss between the
  --    agreed receivable and live costs (deliberate: books track reality);
  --  * net, baseline <= 0 (real demand collapsed): the product's live
  --    contribution is final_count × gb_price − all costs, and the desired
  --    display is expected − all costs, so the waiver is final_count ×
  --    gb_price − expected — covering fractional/negative baselines, CEIL
  --    steps, and testing with no term-by-term modeling.
  SELECT t.group_buy_id,
         SUM(t.net_waiver_usd) AS at_cost_margin_usd,
         SUM(t.revenue_waiver_usd) AS revenue_waiver_usd
  FROM (
    SELECT gbp.group_buy_id,
           SUM(a.qty) * gbp.gb_price_usd - SUM(COALESCE(a.expected_usd, 0)) AS revenue_waiver_usd,
           CASE WHEN pp.final_count - SUM(a.qty) > 0
                THEN SUM(a.qty) * gbp.gb_price_usd - SUM(COALESCE(a.expected_usd, 0))
                ELSE pp.final_count * gbp.gb_price_usd - SUM(COALESCE(a.expected_usd, 0))
           END AS net_waiver_usd
    FROM admin_adjustments a
    JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
    JOIN v_product_profit pp ON pp.group_buy_product_id = gbp.id
    WHERE a.pricing = 'cost' AND NOT a.preordered
    GROUP BY gbp.group_buy_id, gbp.id, gbp.gb_price_usd, pp.final_count
  ) t
  GROUP BY t.group_buy_id
) atc ON atc.group_buy_id = gb.id;

