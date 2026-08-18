-- GROUP STOCK as a direct adjustment: at-cost rows assigned to 'both'
-- whose value comes out of NET PROFIT PRE-SPLIT (no receivable) — the
-- same economics as a stock-plan commit, without needing a plan line.
-- The semantic marker moves from "linked to a stock-plan item" to an
-- explicit boolean, so the planner's commits and direct adjustments are
-- the SAME kind (plan commits additionally carry their plan-line link):
--   pricing='cost', beneficiary='both', NOT stock -> outside-customer
--     sale (receivable + mark-received, P&L neutral)
--   pricing='cost', beneficiary=party            -> personal stock
--     (party payout deduction, P&L neutral)
--   pricing='cost', beneficiary='both', stock    -> GROUP STOCK
--     (net-profit deduction, no receivable; stock_plan_item_id set when
--      it came from a planner commit)
ALTER TABLE admin_adjustments ADD COLUMN stock boolean NOT NULL DEFAULT false;
UPDATE admin_adjustments SET stock = true WHERE stock_plan_item_id IS NOT NULL;

-- v_group_buy_pnl: the stock/customer split now keys on a.stock instead
-- of the plan-line link. Same formulas, same appended columns.
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
                    COALESCE(sum(a.qty) FILTER (WHERE NOT a.stock), 0::numeric) * gbp.gb_price_usd
                      - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE NOT a.stock), 0::numeric) AS cust_revenue_waiver_usd,
                        CASE
                            WHEN (pp.final_count - sum(a.qty)) > 0::numeric
                            THEN COALESCE(sum(a.qty) FILTER (WHERE NOT a.stock), 0::numeric) * gbp.gb_price_usd
                                   - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE NOT a.stock), 0::numeric)
                            ELSE (pp.final_count - COALESCE(sum(a.qty) FILTER (WHERE a.stock), 0::numeric)) * gbp.gb_price_usd
                                   - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE NOT a.stock), 0::numeric)
                        END AS cust_net_waiver_usd,
                    COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE a.stock), 0::numeric) AS stock_cost_usd,
                        CASE
                            WHEN (pp.final_count - sum(a.qty)) > 0::numeric
                            THEN COALESCE(sum(a.qty) FILTER (WHERE a.stock), 0::numeric) * gbp.gb_price_usd
                            ELSE GREATEST(LEAST(pp.final_count, COALESCE(sum(a.qty) FILTER (WHERE a.stock), 0::numeric)), 0::numeric) * gbp.gb_price_usd
                        END AS stock_retail_usd
                   FROM admin_adjustments a
                     JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
                     JOIN v_product_profit pp ON pp.group_buy_product_id = gbp.id
                  WHERE a.pricing = 'cost'::text AND NOT a.preordered
                  GROUP BY gbp.group_buy_id, gbp.id, gbp.gb_price_usd, pp.final_count) t
          GROUP BY t.group_buy_id) atc ON atc.group_buy_id = gb.id;

-- commit_stock_plan() must stamp the new flag: without this, future
-- planner commits would default to stock = false and the view (now
-- keyed on the flag) would misclassify them as customer receivables.
CREATE OR REPLACE FUNCTION commit_stock_plan(
  p_group_buy_id bigint,
  p_actor text,
  p_confirmed text
) RETURNS TABLE (id bigint)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_plan_id bigint;
BEGIN
  IF p_confirmed IS NULL OR p_confirmed = '' THEN
    RETURN;
  END IF;

  SELECT sp.id INTO v_plan_id
  FROM stock_plans sp
  WHERE sp.group_buy_id = p_group_buy_id
  FOR UPDATE;

  IF v_plan_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH confirmed AS (
    SELECT split_part(x, ':', 1)::bigint AS item_id,
           split_part(x, ':', 2)::numeric AS kits
    FROM unnest(string_to_array(p_confirmed, ',')) AS x
  ), pending AS (
    SELECT i.id AS item_id, i.kits, gbp.id AS gbp_id, gbp.status, gbp.cost_tier_qty,
           gbp.unit_cost_usd, gbp.freight_usd, p.sku_code
    FROM stock_plan_items i
    JOIN group_buy_products gbp ON gbp.id = i.group_buy_product_id
    JOIN products p ON p.id = gbp.product_id
    WHERE i.plan_id = v_plan_id
      AND i.id IN (SELECT c.item_id FROM confirmed c)
      AND NOT EXISTS (SELECT 1 FROM admin_adjustments a WHERE a.stock_plan_item_id = i.id)
    FOR UPDATE OF i, gbp
  ), drift AS (
    SELECT 1 AS hit
    FROM confirmed c
    LEFT JOIN pending pd ON pd.item_id = c.item_id
    WHERE pd.item_id IS NULL
       OR pd.kits <> c.kits
       OR pd.status <> 'active'
       OR pd.cost_tier_qty IS NOT NULL
    UNION ALL
    SELECT 1
    FROM stock_plan_items i
    WHERE i.plan_id = v_plan_id
      AND i.id NOT IN (SELECT c.item_id FROM confirmed c)
      AND NOT EXISTS (SELECT 1 FROM admin_adjustments a WHERE a.stock_plan_item_id = i.id)
  ), ins AS (
    INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by, beneficiary, pricing, expected_usd, preordered, stock_plan_item_id, stock)
    SELECT pd.gbp_id, pd.kits,
           'Stock plan commit: ' || pd.sku_code || ' x ' || pd.kits::text,
           p_actor, 'both', 'cost',
           ROUND(pd.kits * (pd.unit_cost_usd + pd.freight_usd), 2),
           false, pd.item_id, true
    FROM pending pd
    WHERE NOT EXISTS (SELECT 1 FROM drift)
    RETURNING admin_adjustments.id, admin_adjustments.group_buy_product_id,
              admin_adjustments.qty, admin_adjustments.expected_usd,
              admin_adjustments.stock_plan_item_id
  ), audit AS (
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    SELECT 'admin_adjustments', ins.id::text, 'stock_plan_committed', p_actor,
           jsonb_build_object('group_buy_product_id', ins.group_buy_product_id, 'qty', ins.qty,
                              'expected_usd', ins.expected_usd, 'stock_plan_item_id', ins.stock_plan_item_id)
    FROM ins
    RETURNING row_pk
  )
  SELECT ins.id FROM ins;
END $fn$;
