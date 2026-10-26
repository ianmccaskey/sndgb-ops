-- Admin adjustments for items that are NOT a campaign product ("Other").
--
-- Ian, 2026-10-26: "I would like to be able to add Admin Adjustments for
-- items not in the current campaign. Select Other from product drop down
-- and it will let you manually enter product name, vendor cost, and
-- select who it is assigned to."
--
-- An "Other" row is an AT-COST purchase from one of the campaign's vendors
-- of something the campaign does not sell: it carries its own name and
-- unit vendor cost instead of a group_buy_product_id, and takes the same
-- three at-cost assignments a campaign-product row can:
--   * a party        → PERSONAL: expected_usd comes out of that party's
--                      payout (getPnl's per-beneficiary figure); P&L neutral;
--   * both + stock   → GROUP STOCK: expected_usd comes out of net profit
--                      (v_group_buy_pnl.other_stock_usd) and is funded
--                      equally by the partners like every group-stock row;
--   * both, no stock → OUTSIDE CUSTOMER: a receivable until marked received.
-- In every case the VENDOR is owed the cost: v_vendor_balances.owed_usd
-- includes it (other_owed_usd), so paying the vendor for it reconciles
-- instead of reading as OVERPAID. Nothing else changes: no demand, no MOQ,
-- no kits in the vendor ledger (there is no product to attribute them to),
-- no testing cost, no freight — the entered cost is the landed cost.
--
-- group_buy_id now lives on EVERY adjustment row (backfilled from the
-- product; a composite FK keeps a product row's campaign equal to its
-- product's), so campaign scoping no longer needs the product join.

ALTER TABLE admin_adjustments
  ALTER COLUMN group_buy_product_id DROP NOT NULL,
  ADD COLUMN group_buy_id BIGINT REFERENCES group_buys(id),
  ADD COLUMN other_name TEXT,
  ADD COLUMN other_unit_cost_usd NUMERIC(12,2),
  ADD COLUMN vendor_id BIGINT REFERENCES vendors(id);

UPDATE admin_adjustments a
SET group_buy_id = gbp.group_buy_id
FROM group_buy_products gbp
WHERE gbp.id = a.group_buy_product_id
  AND a.group_buy_id IS NULL;

ALTER TABLE admin_adjustments
  ALTER COLUMN group_buy_id SET NOT NULL,
  -- a campaign-product row's campaign IS its product's campaign
  ADD CONSTRAINT admin_adjustments_product_campaign_fk
    FOREIGN KEY (group_buy_product_id, group_buy_id)
    REFERENCES group_buy_products (id, group_buy_id) ON DELETE CASCADE,
  -- exactly one shape: a campaign product, or an Other item with name,
  -- unit cost and vendor — always at cost, whole positive qty, never
  -- preordered (there is no demand to pre-empt), never a planner line
  ADD CONSTRAINT admin_adjustments_other_shape CHECK (
    (group_buy_product_id IS NOT NULL
     AND other_name IS NULL AND other_unit_cost_usd IS NULL AND vendor_id IS NULL)
    OR
    (group_buy_product_id IS NULL
     AND other_name IS NOT NULL AND btrim(other_name) <> ''
     AND other_unit_cost_usd IS NOT NULL AND other_unit_cost_usd > 0
     AND vendor_id IS NOT NULL
     AND pricing = 'cost' AND NOT preordered AND stock_plan_item_id IS NULL
     AND qty > 0 AND qty % 1 = 0
     AND expected_usd IS NOT NULL)
  );

CREATE INDEX admin_adjustments_gb_idx ON admin_adjustments (group_buy_id);
CREATE INDEX admin_adjustments_other_vendor_idx ON admin_adjustments (vendor_id, group_buy_id)
  WHERE group_buy_product_id IS NULL;

-- group stock on a campaign product still needs an active flat-cost line;
-- an Other row has no product to check (the CHECK above shapes it)
CREATE OR REPLACE FUNCTION enforce_stock_adjustment_product() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_status text;
  v_tier numeric;
BEGIN
  IF NEW.stock AND NEW.group_buy_product_id IS NOT NULL THEN
    SELECT gbp.status::text, gbp.cost_tier_qty INTO v_status, v_tier
    FROM group_buy_products gbp
    WHERE gbp.id = NEW.group_buy_product_id;
    IF v_status IS DISTINCT FROM 'active' OR v_tier IS NOT NULL THEN
      RAISE EXCEPTION 'group stock requires an active flat-cost product (status %, tier qty %)', v_status, v_tier
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

-- P&L: Other GROUP STOCK comes out of net profit (its own column, so the
-- Dispersion composition and the payout math add it explicitly; the
-- campaign-product stock_cost/stock_retail pair is unchanged). Personal
-- and outside-customer Other rows never touch P&L.
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
    COALESCE(prod.product_profit_usd, 0::numeric) + COALESCE(ord.admin_fees_usd, 0::numeric) + COALESCE(ord.tips_usd, 0::numeric) + COALESCE(spl.split_fees_usd, 0::numeric) - (COALESCE(exp.expenses_usd, 0::numeric) - COALESCE(exp.shipping_expenses_usd, 0::numeric)) - COALESCE(cmp.comps_usd, 0::numeric) - COALESCE(cred.credits_usd, 0::numeric) - COALESCE(wo.writeoffs_usd, 0::numeric) - COALESCE(adjb.adj_both_usd, 0::numeric) - COALESCE(dfr.direct_freight_usd, 0::numeric) - COALESCE(atc.at_cost_margin_usd, 0::numeric) - COALESCE(atc.stock_retail_usd, 0::numeric) - COALESCE(oth.other_stock_usd, 0::numeric) AS net_profit_usd,
    COALESCE(dfr.direct_freight_usd, 0::numeric) AS direct_freight_usd,
    COALESCE(spl.split_fees_usd, 0::numeric) AS split_fees_usd,
    COALESCE(atc.at_cost_margin_usd, 0::numeric) AS at_cost_margin_usd,
    COALESCE(atc.stock_cost_usd, 0::numeric) AS stock_cost_usd,
    COALESCE(atc.stock_retail_usd, 0::numeric) AS stock_retail_usd,
    COALESCE(exp.shipping_expenses_usd, 0::numeric) AS shipping_expenses_usd,
    COALESCE(ord.shipping_fees_usd, 0::numeric) + COALESCE(ord.insurance_usd, 0::numeric) - COALESCE(ship.label_costs_usd, 0::numeric) - COALESCE(exp.shipping_expenses_usd, 0::numeric) AS shipping_net_usd,
    COALESCE(oth.other_stock_usd, 0::numeric) AS other_stock_usd
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
            sum(expenses.total_usd) AS expenses_usd,
            sum(expenses.total_usd) FILTER (WHERE expenses.category = ANY (ARRAY['shipping'::expense_category, 'reship'::expense_category])) AS shipping_expenses_usd
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
                    COALESCE(sum(a.qty) FILTER (WHERE NOT a.stock), 0::numeric) * gbp.gb_price_usd - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE NOT a.stock), 0::numeric) AS cust_revenue_waiver_usd,
                        CASE
                            WHEN (pp.final_count - sum(a.qty)) > 0::numeric THEN COALESCE(sum(a.qty) FILTER (WHERE NOT a.stock), 0::numeric) * gbp.gb_price_usd - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE NOT a.stock), 0::numeric)
                            ELSE (pp.final_count - COALESCE(sum(a.qty) FILTER (WHERE a.stock), 0::numeric)) * gbp.gb_price_usd - COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE NOT a.stock), 0::numeric)
                        END AS cust_net_waiver_usd,
                    COALESCE(sum(COALESCE(a.expected_usd, 0::numeric)) FILTER (WHERE a.stock), 0::numeric) AS stock_cost_usd,
                        CASE
                            WHEN (pp.final_count - sum(a.qty)) > 0::numeric THEN COALESCE(sum(a.qty) FILTER (WHERE a.stock), 0::numeric) * gbp.gb_price_usd
                            ELSE GREATEST(LEAST(pp.final_count, COALESCE(sum(a.qty) FILTER (WHERE a.stock), 0::numeric)), 0::numeric) * gbp.gb_price_usd
                        END AS stock_retail_usd
                   FROM admin_adjustments a
                     JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
                     JOIN v_product_profit pp ON pp.group_buy_product_id = gbp.id
                  WHERE a.pricing = 'cost'::text AND NOT a.preordered
                  GROUP BY gbp.group_buy_id, gbp.id, gbp.gb_price_usd, pp.final_count) t
          GROUP BY t.group_buy_id) atc ON atc.group_buy_id = gb.id
     -- Other-item GROUP STOCK (1790102300): no product, no margin, no
     -- retail — the cost alone comes out of net profit
     LEFT JOIN ( SELECT a.group_buy_id,
            sum(COALESCE(a.expected_usd, 0::numeric)) AS other_stock_usd
           FROM admin_adjustments a
          WHERE a.group_buy_product_id IS NULL AND a.stock
          GROUP BY a.group_buy_id) oth ON oth.group_buy_id = gb.id;

-- Vendor balances: an Other item is money owed to its vendor
-- (other_owed_usd), whoever it is assigned to. Kits and freight ledgers
-- are untouched — there is no product to attribute kits to.
CREATE OR REPLACE VIEW v_vendor_balances AS
 SELECT v.id AS vendor_id,
    v.code AS vendor_code,
    gb.id AS group_buy_id,
    gb.name AS group_buy_name,
    sum(pp.owed_to_vendor_usd) + sum(
        CASE
            WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
            ELSE 0::numeric
        END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric) AS owed_usd,
    sum(pp.owed_to_vendor_usd) AS product_owed_usd,
    sum(
        CASE
            WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
            ELSE 0::numeric
        END) + COALESCE(df.direct_freight_usd, 0::numeric) AS freight_demand_usd,
    sum(pp.ordered_kits) AS kits_demand,
    COALESCE(vp.paid_usd, 0::numeric) AS paid_usd,
    COALESCE(vp.kits_paid, 0::numeric) AS kits_paid,
    COALESCE(vp.freight_paid_usd, 0::numeric) AS freight_paid_usd,
    sum(pp.owed_to_vendor_usd) + sum(
        CASE
            WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
            ELSE 0::numeric
        END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric) - COALESCE(vp.paid_usd, 0::numeric) AS balance_usd,
        CASE
            WHEN COALESCE(vp.paid_usd, 0::numeric) = 0::numeric THEN 'unpaid'::text
            WHEN COALESCE(vp.paid_usd, 0::numeric) < (sum(pp.owed_to_vendor_usd) + sum(
            CASE
                WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
                ELSE 0::numeric
            END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric)) THEN 'partial'::text
            WHEN COALESCE(vp.paid_usd, 0::numeric) = (sum(pp.owed_to_vendor_usd) + sum(
            CASE
                WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
                ELSE 0::numeric
            END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric)) THEN 'paid'::text
            ELSE 'OVERPAID'::text
        END AS pay_status,
    COALESCE(df.direct_freight_usd, 0::numeric) AS direct_freight_demand_usd,
    COALESCE(oa.other_owed_usd, 0::numeric) AS other_owed_usd
   FROM v_product_profit pp
     JOIN vendors v ON v.code = pp.vendor_code
     JOIN group_buys gb ON gb.id = pp.group_buy_id
     LEFT JOIN ( SELECT vendor_payments.vendor_id,
            vendor_payments.group_buy_id,
            sum(vendor_payments.amount_usd) AS paid_usd,
            sum(COALESCE(vendor_payments.kits_qty, 0::numeric)) AS kits_paid,
            sum(COALESCE(vendor_payments.freight_usd, 0::numeric)) AS freight_paid_usd
           FROM vendor_payments
          GROUP BY vendor_payments.vendor_id, vendor_payments.group_buy_id) vp ON vp.vendor_id = v.id AND vp.group_buy_id = gb.id
     LEFT JOIN ( SELECT v_direct_freight.vendor_id,
            v_direct_freight.group_buy_id,
            sum(v_direct_freight.direct_freight_usd) AS direct_freight_usd
           FROM v_direct_freight
          GROUP BY v_direct_freight.vendor_id, v_direct_freight.group_buy_id) df ON df.vendor_id = v.id AND df.group_buy_id = gb.id
     LEFT JOIN ( SELECT a.vendor_id,
            a.group_buy_id,
            sum(COALESCE(a.expected_usd, 0::numeric)) AS other_owed_usd
           FROM admin_adjustments a
          WHERE a.group_buy_product_id IS NULL
          GROUP BY a.vendor_id, a.group_buy_id) oa ON oa.vendor_id = v.id AND oa.group_buy_id = gb.id
  GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd, vp.kits_paid, vp.freight_paid_usd, df.direct_freight_usd, oa.other_owed_usd;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102300_other_item_adjustments.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102300_other_item_adjustments.sql');
