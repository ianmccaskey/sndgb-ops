-- Admin adjustments get a beneficiary: which organizer the units are for
-- ('both', or a profit_splits.party name — 'Paige' / 'Porgy' today; validated
-- against profit_splits in the action, not a CHECK, so parties stay data).
--
-- Money model: an adjustment's value is qty × the line's GB price — the
-- adjustment already books that value as expected revenue in v_product_profit
-- (final_count × gb_price), so the beneficiary "buys at GB price":
--  - beneficiary = 'both'  → value deducted from total revenue and net profit
--    in v_group_buy_pnl (the pair absorbs it before the split);
--  - beneficiary = a party → value deducted from THAT party's split payout
--    (computed in the P&L displays from getPnl's per-beneficiary aggregate);
--    total revenue/net stay as-is, so the other partner still earns their
--    share of the margin — economically the person bought as a customer.

ALTER TABLE admin_adjustments ADD COLUMN beneficiary TEXT NOT NULL DEFAULT 'unattributed';

-- Legacy rows and any writer that omits beneficiary must NOT silently become
-- 'both' (that would move value into the shared deduction without anyone
-- deciding). The 'unattributed' default/backfill is never accepted by
-- addAdjustment's validation and matches no split party, so the P&L displays
-- show these as loud "Unattributed adjustments" warnings until an operator
-- deletes and re-adds them with an explicit beneficiary. Attribution is
-- always an explicit act — 'both' only ever arrives via the validated action.
UPDATE admin_adjustments SET beneficiary = 'unattributed';

DROP VIEW IF EXISTS v_group_buy_pnl;

CREATE VIEW v_group_buy_pnl AS
SELECT
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  COALESCE(prod.expected_revenue_usd, 0) AS product_revenue_usd,
  COALESCE(ord.order_count, 0) AS order_count,
  COALESCE(ord.admin_fees_usd, 0) AS admin_fee_revenue_usd,
  COALESCE(ord.shipping_fees_usd, 0) AS shipping_fee_revenue_usd,
  COALESCE(ord.tips_usd, 0) AS tip_revenue_usd,
  COALESCE(cmp.comps_usd, 0) AS comps_usd,
  COALESCE(wo.writeoffs_usd, 0) AS writeoffs_usd,
  COALESCE(adjb.adj_both_usd, 0) AS adj_both_usd,
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(cmp.comps_usd, 0) - COALESCE(wo.writeoffs_usd, 0)
    - COALESCE(adjb.adj_both_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0)
    - COALESCE(cmp.comps_usd, 0) - COALESCE(wo.writeoffs_usd, 0)
    - COALESCE(adjb.adj_both_usd, 0) AS net_profit_usd
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
) ship ON ship.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(LEAST(oi.comp_qty, oi.qty) * oi.unit_price_usd) AS comps_usd
  FROM order_items oi
  JOIN orders o ON o.id = oi.order_id
  WHERE o.status NOT IN ('cancelled','refunded') AND oi.comp_qty > 0
  GROUP BY o.group_buy_id
) cmp ON cmp.group_buy_id = gb.id
LEFT JOIN (
  SELECT o.group_buy_id, SUM(w.amount_usd) AS writeoffs_usd
  FROM order_writeoffs w
  JOIN orders o ON o.id = w.order_id
  WHERE o.status NOT IN ('cancelled','refunded')
  GROUP BY o.group_buy_id
) wo ON wo.group_buy_id = gb.id
LEFT JOIN (
  SELECT gbp.group_buy_id, SUM(a.qty * gbp.gb_price_usd) AS adj_both_usd
  FROM admin_adjustments a
  JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
  WHERE a.beneficiary = 'both'
  GROUP BY gbp.group_buy_id
) adjb ON adjb.group_buy_id = gb.id;
