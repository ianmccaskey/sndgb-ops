-- Stock-plan COMMIT: planner allocations become real vendor demand as
-- admin adjustments at vendor cost + freight, assigned to 'both' so the
-- value pulls from NET PROFIT PRE-SPLIT (no receivable, no per-party
-- payout deduction — the group's own stock, paid out of the group's
-- profit before anyone's share is computed).
--
-- The link column marks the third kind of at-cost adjustment:
--   pricing='cost', beneficiary='both', stock_plan_item_id IS NULL
--     -> outside-customer sale (receivable + mark-received, P&L neutral)
--   pricing='cost', beneficiary=party
--     -> personal stock (party payout deduction, P&L neutral)
--   pricing='cost', beneficiary='both', stock_plan_item_id IS NOT NULL
--     -> STOCK PLAN COMMIT (net-profit deduction, no receivable)
ALTER TABLE admin_adjustments
  ADD COLUMN stock_plan_item_id bigint REFERENCES stock_plan_items(id);

-- one committed adjustment per plan line, ever — the partial unique index
-- makes double-commit racing two clicks insert exactly one row
CREATE UNIQUE INDEX admin_adjustments_stock_plan_item_uniq
  ON admin_adjustments (stock_plan_item_id)
  WHERE stock_plan_item_id IS NOT NULL;

-- v_group_buy_pnl: the at-cost subquery splits per kind.
--   CUSTOMER rows (no stock link): unchanged semantics — margin waived,
--   the snapshotted receivable stays booked as revenue (neutral at entry).
--   STOCK rows: the kits were never sold, so their FULL retail value is
--   waived from revenue; their booked cost side (demand cost + per-kit
--   freight) then pulls net profit down by exactly the snapshotted
--   cost+freight. Degenerate branch (organic demand net-negative) mirrors
--   the customer clamp: never waive more retail than final_count credits.
-- Columns are APPEND-ONLY (order load-bearing for CREATE OR REPLACE):
-- stock_cost_usd + stock_retail_usd land after at_cost_margin_usd.
CREATE OR REPLACE VIEW v_group_buy_pnl AS
SELECT gb.id AS group_buy_id,
    gb.name AS group_buy_name,
    COALESCE(prod.expected_revenue_usd, 0::numeric) AS product_revenue_usd,
    COALESCE(ord.order_count, 0::bigint) AS order_count,
    COALESCE(ord.admin_fees_usd, 0::numeric) AS admin_fee_revenue_usd,
    COALESCE(ord.shipping_fees_usd, 0::numeric) AS shipping_fee_revenue_usd,
    COALESCE(ord.insurance_usd, 0::numeric) AS insurance_revenue_usd,
    COALESCE(ord.tips_usd, 0::numeric) AS tip_revenue_usd,
    COALESCE(cmp.comps_usd, 0::numeric) AS comps_usd,
    COALESCE(cred.credits_usd, 0::numeric) AS credits_usd,
    COALESCE(wo.writeoffs_usd, 0::numeric) AS writeoffs_usd,
    COALESCE(adjb.adj_both_usd, 0::numeric) AS adj_both_usd,
    COALESCE(prod.expected_revenue_usd, 0::numeric) + COALESCE(ord.admin_fees_usd, 0::numeric) + COALESCE(ord.shipping_fees_usd, 0::numeric) + COALESCE(ord.insurance_usd, 0::numeric) + COALESCE(ord.tips_usd, 0::numeric) + COALESCE(spl.split_fees_usd, 0::numeric) - COALESCE(cmp.comps_usd, 0::numeric) - COALESCE(cred.credits_usd, 0::numeric) - COALESCE(wo.writeoffs_usd, 0::numeric) - COALESCE(adjb.adj_both_usd, 0::numeric) - COALESCE(atc.revenue_waiver_usd, 0::numeric) - COALESCE(atc.stock_retail_usd, 0::numeric) AS total_revenue_usd,
    COALESCE(prod.product_profit_usd, 0::numeric) AS product_profit_usd,
    COALESCE(exp.expenses_usd, 0::numeric) AS expenses_usd,
    COALESCE(ship.label_costs_usd, 0::numeric) AS label_costs_usd,
    COALESCE(prod.product_profit_usd, 0::numeric) + COALESCE(ord.admin_fees_usd, 0::numeric) + COALESCE(ord.shipping_fees_usd, 0::numeric) + COALESCE(ord.insurance_usd, 0::numeric) + COALESCE(ord.tips_usd, 0::numeric) + COALESCE(spl.split_fees_usd, 0::numeric) - COALESCE(exp.expenses_usd, 0::numeric) - COALESCE(ship.label_costs_usd, 0::numeric) - COALESCE(cmp.comps_usd, 0::numeric) - COALESCE(cred.credits_usd, 0::numeric) - COALESCE(wo.writeoffs_usd, 0::numeric) - COALESCE(adjb.adj_both_usd, 0::numeric) - COALESCE(dfr.direct_freight_usd, 0::numeric) - COALESCE(atc.at_cost_margin_usd, 0::numeric) - COALESCE(atc.stock_retail_usd, 0::numeric) AS net_profit_usd,
    COALESCE(dfr.direct_freight_usd, 0::numeric) AS direct_freight_usd,
    COALESCE(spl.split_fees_usd, 0::numeric) AS split_fees_usd,
    COALESCE(atc.at_cost_margin_usd, 0::numeric) AS at_cost_margin_usd,
    COALESCE(atc.stock_cost_usd, 0::numeric) AS stock_cost_usd,
    COALESCE(atc.stock_retail_usd, 0::numeric) AS stock_retail_usd
   FROM group_buys gb
     LEFT JOIN ( SELECT v_product_profit.group_buy_id,
            sum(v_product_profit.expected_revenue_usd) AS expected_revenue_usd,
            sum(v_product_profit.total_product_profit_usd) AS product_profit_usd
           FROM v_product_profit
          GROUP BY v_product_profit.group_buy_id) prod ON prod.group_buy_id = gb.id
     LEFT JOIN ( SELECT orders.group_buy_id,
            count(*) AS order_count,
            sum(COALESCE(orders.admin_fee_override_usd, orders.admin_fee_usd)) AS admin_fees_usd,
            sum(COALESCE(orders.shipping_fee_override_usd, orders.shipping_fee_usd)) AS shipping_fees_usd,
            sum(COALESCE(orders.shipping_insurance_override_usd, orders.shipping_insurance_usd)) AS insurance_usd,
            sum(COALESCE(orders.tip_override_usd, orders.tip_usd)) AS tips_usd
           FROM orders
          WHERE orders.status <> ALL (ARRAY['cancelled'::order_status, 'refunded'::order_status])
          GROUP BY orders.group_buy_id) ord ON ord.group_buy_id = gb.id
     LEFT JOIN ( SELECT expenses.group_buy_id,
            sum(expenses.total_usd) AS expenses_usd
           FROM expenses
          GROUP BY expenses.group_buy_id) exp ON exp.group_buy_id = gb.id
     LEFT JOIN ( SELECT o.group_buy_id,
            sum(s.label_cost_usd) AS label_costs_usd
           FROM shipments s
             JOIN orders o ON o.id = s.order_id
          GROUP BY o.group_buy_id) ship ON ship.group_buy_id = gb.id
     LEFT JOIN ( SELECT o.group_buy_id,
            sum(LEAST(oi.comp_qty,
                CASE
                    WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty)
                    ELSE 0::numeric
                END) * oi.unit_price_usd) AS comps_usd
           FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
          WHERE (o.status <> ALL (ARRAY['cancelled'::order_status, 'refunded'::order_status])) AND oi.comp_qty > 0::numeric
          GROUP BY o.group_buy_id) cmp ON cmp.group_buy_id = gb.id
     LEFT JOIN ( SELECT o.group_buy_id,
            sum(oc.amount_usd) AS credits_usd
           FROM order_credits oc
             JOIN orders o ON o.id = oc.order_id
          WHERE o.status <> ALL (ARRAY['cancelled'::order_status, 'refunded'::order_status])
          GROUP BY o.group_buy_id) cred ON cred.group_buy_id = gb.id
     LEFT JOIN ( SELECT o.group_buy_id,
            sum(w.amount_usd) AS writeoffs_usd
           FROM order_writeoffs w
             JOIN orders o ON o.id = w.order_id
          WHERE o.status <> ALL (ARRAY['cancelled'::order_status, 'refunded'::order_status])
          GROUP BY o.group_buy_id) wo ON wo.group_buy_id = gb.id
     LEFT JOIN ( SELECT gbp.group_buy_id,
            sum(a.qty * gbp.gb_price_usd) AS adj_both_usd
           FROM admin_adjustments a
             JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
          WHERE a.beneficiary = 'both'::text AND a.pricing = 'gb'::text
          GROUP BY gbp.group_buy_id) adjb ON adjb.group_buy_id = gb.id
     LEFT JOIN ( SELECT v_direct_freight.group_buy_id,
            sum(v_direct_freight.direct_freight_usd) AS direct_freight_usd
           FROM v_direct_freight
          GROUP BY v_direct_freight.group_buy_id) dfr ON dfr.group_buy_id = gb.id
     LEFT JOIN ( SELECT o.group_buy_id,
            sum(oi.split_fee_usd) AS split_fees_usd
           FROM order_items oi
             JOIN orders o ON o.id = oi.order_id
          WHERE (o.status <> ALL (ARRAY['cancelled'::order_status, 'refunded'::order_status])) AND oi.removed_at IS NULL AND oi.split_fee_usd > 0::numeric
          GROUP BY o.group_buy_id) spl ON spl.group_buy_id = gb.id
     LEFT JOIN ( SELECT t.group_buy_id,
            sum(t.cust_net_waiver_usd) AS at_cost_margin_usd,
            sum(t.cust_revenue_waiver_usd) AS revenue_waiver_usd,
            sum(t.stock_cost_usd) AS stock_cost_usd,
            sum(t.stock_retail_usd) AS stock_retail_usd
           FROM ( SELECT gbp.group_buy_id,
                    COALESCE(sum(a.qty) FILTER (WHERE a.stock_plan_item_id IS NULL), 0::numeric) * gbp.gb_price_usd
                      - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE a.stock_plan_item_id IS NULL), 0::numeric) AS cust_revenue_waiver_usd,
                        CASE
                            WHEN (pp.final_count - sum(a.qty)) > 0::numeric
                            THEN COALESCE(sum(a.qty) FILTER (WHERE a.stock_plan_item_id IS NULL), 0::numeric) * gbp.gb_price_usd
                                   - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE a.stock_plan_item_id IS NULL), 0::numeric)
                            ELSE (pp.final_count - COALESCE(sum(a.qty) FILTER (WHERE a.stock_plan_item_id IS NOT NULL), 0::numeric)) * gbp.gb_price_usd
                                   - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE a.stock_plan_item_id IS NULL), 0::numeric)
                        END AS cust_net_waiver_usd,
                    COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE a.stock_plan_item_id IS NOT NULL), 0::numeric) AS stock_cost_usd,
                        CASE
                            WHEN (pp.final_count - sum(a.qty)) > 0::numeric
                            THEN COALESCE(sum(a.qty) FILTER (WHERE a.stock_plan_item_id IS NOT NULL), 0::numeric) * gbp.gb_price_usd
                            ELSE GREATEST(LEAST(pp.final_count, COALESCE(sum(a.qty) FILTER (WHERE a.stock_plan_item_id IS NOT NULL), 0::numeric)), 0::numeric) * gbp.gb_price_usd
                        END AS stock_retail_usd
                   FROM admin_adjustments a
                     JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
                     JOIN v_product_profit pp ON pp.group_buy_product_id = gbp.id
                  WHERE a.pricing = 'cost'::text AND NOT a.preordered
                  GROUP BY gbp.group_buy_id, gbp.id, gbp.gb_price_usd, pp.final_count) t
          GROUP BY t.group_buy_id) atc ON atc.group_buy_id = gb.id;
