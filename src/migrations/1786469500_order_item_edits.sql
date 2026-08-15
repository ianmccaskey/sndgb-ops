-- Editable/removable order items, pull-proof, pushable upstream — the item
-- analog of the fee overrides:
--   qty_override  NULL = follow the ordering app's qty; a value wins over
--                 every pull until upstream catches up.
--   removed_at    the line is removed from the order HERE while upstream
--                 still carries it; imports keep refreshing the base row,
--                 pulls delete it only when upstream drops the product AND
--                 the header total moved in the same pull (partial-push gate).
--
-- Money and demand both use the EFFECTIVE quantity:
--   effective_qty = 0 when removed, else COALESCE(qty_override, qty)
-- so billing (recon), kit demand / vendor owed (moq chain), comp values, and
-- P&L all move together with an edit. Reconciliation bills
--   total_usd + local items (effective value) + fee deltas
--   + item edit deltas ((effective − imported qty) × price on imported rows).

ALTER TABLE order_items ADD COLUMN qty_override NUMERIC(10,2)
  CHECK (qty_override IS NULL OR qty_override > 0);
ALTER TABLE order_items ADD COLUMN removed_at TIMESTAMPTZ;

-- ---- demand chain (moq → profit → balances → pnl) on effective qty ----
DROP VIEW IF EXISTS v_group_buy_pnl;
DROP VIEW IF EXISTS v_vendor_balances;
DROP VIEW IF EXISTS v_product_profit;
DROP VIEW IF EXISTS v_moq_progress;

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
  -- EFFECTIVE demand: removed lines contribute nothing, edited lines their
  -- edited qty — we neither owe the vendor for removed kits nor under-order
  -- edited ones
  SELECT oi.group_buy_product_id,
         SUM(CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) AS demand_qty
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

CREATE VIEW v_vendor_balances AS
SELECT
  v.id AS vendor_id,
  v.code AS vendor_code,
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) AS owed_usd,
  SUM(pp.owed_to_vendor_usd) AS product_owed_usd,
  SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) AS freight_demand_usd,
  SUM(pp.final_count) AS kits_demand,
  COALESCE(vp.paid_usd, 0) AS paid_usd,
  COALESCE(vp.kits_paid, 0) AS kits_paid,
  COALESCE(vp.freight_paid_usd, 0) AS freight_paid_usd,
  SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) - COALESCE(vp.paid_usd, 0) AS balance_usd,
  CASE
    WHEN COALESCE(vp.paid_usd, 0) = 0 THEN 'unpaid'
    WHEN COALESCE(vp.paid_usd, 0) < SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) THEN 'partial'
    WHEN COALESCE(vp.paid_usd, 0) = SUM(pp.owed_to_vendor_usd) + SUM(CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END) THEN 'paid'
    ELSE 'OVERPAID'
  END AS pay_status
FROM v_product_profit pp
JOIN vendors v ON v.code = pp.vendor_code
JOIN group_buys gb ON gb.id = pp.group_buy_id
LEFT JOIN (
  SELECT vendor_id, group_buy_id,
         SUM(amount_usd) AS paid_usd,
         SUM(COALESCE(kits_qty, 0)) AS kits_paid,
         SUM(COALESCE(freight_usd, 0)) AS freight_paid_usd
  FROM vendor_payments
  GROUP BY vendor_id, group_buy_id
) vp ON vp.vendor_id = v.id AND vp.group_buy_id = gb.id
GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd, vp.kits_paid, vp.freight_paid_usd;

-- ---- reconciliation on effective quantities ----
DROP VIEW IF EXISTS v_rail_reconciliation;
DROP VIEW IF EXISTS v_order_reconciliation;

CREATE VIEW v_order_reconciliation AS
SELECT
  o.id AS order_id,
  o.order_number,
  o.group_buy_id,
  o.customer_id,
  c.display_name AS customer_name,
  o.payment_rail,
  o.status AS order_status,
  o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) AS billed_usd,
  COALESCE(li.local_usd, 0) AS local_items_usd,
  fd.fee_delta_usd,
  COALESCE(ie.item_delta_usd, 0) AS item_delta_usd,
  COALESCE(cp.comp_usd, 0) AS comp_usd,
  COALESCE(wo.amount_usd, 0) AS writeoff_usd,
  o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0) AS due_usd,
  COALESCE(pv.verified_usd, 0) AS received_usd,
  ov.override_usd,
  COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS effective_received_usd,
  (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS diff_usd,
  COALESCE(pp.pending_count, 0) AS pending_payment_count,
  CASE
    WHEN COALESCE(pv.verified_usd, 0) = 0 AND ov.override_usd IS NULL
         AND (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) > gb.reconcile_tolerance_usd THEN 'awaiting'
    WHEN ABS((o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0))) <= gb.reconcile_tolerance_usd THEN 'matched'
    WHEN (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) > COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) THEN 'short'
    ELSE 'over'
  END AS recon_status
FROM orders o
CROSS JOIN LATERAL (
  SELECT (COALESCE(o.admin_fee_override_usd, o.admin_fee_usd) - o.admin_fee_usd)
       + (COALESCE(o.shipping_fee_override_usd, o.shipping_fee_usd) - o.shipping_fee_usd)
       + (COALESCE(o.shipping_insurance_override_usd, o.shipping_insurance_usd) - o.shipping_insurance_usd)
       + (COALESCE(o.tip_override_usd, o.tip_usd) - o.tip_usd) AS fee_delta_usd
) fd
JOIN group_buys gb ON gb.id = o.group_buy_id
JOIN customers c ON c.id = o.customer_id
LEFT JOIN (
  SELECT order_id, SUM(amount_usd) AS verified_usd
  FROM payments
  WHERE status = 'verified'
  GROUP BY order_id
) pv ON pv.order_id = o.id
LEFT JOIN (
  SELECT order_id, COUNT(*) AS pending_count
  FROM payments
  WHERE status = 'pending'
  GROUP BY order_id
) pp ON pp.order_id = o.id
LEFT JOIN LATERAL (
  SELECT amount_usd AS override_usd
  FROM payment_overrides po
  WHERE po.order_id = o.id
  ORDER BY po.created_at DESC
  LIMIT 1
) ov ON true
LEFT JOIN (
  -- comps clamp to the EFFECTIVE qty: a removed line's comp is worth 0, an
  -- edited-down line comps at most what the customer now gets
  SELECT oi.order_id,
         SUM(LEAST(oi.comp_qty, CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) * oi.unit_price_usd) AS comp_usd
  FROM order_items oi
  WHERE oi.comp_qty > 0
  GROUP BY oi.order_id
) cp ON cp.order_id = o.id
LEFT JOIN (
  SELECT oi.order_id,
         SUM(CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END * oi.unit_price_usd) AS local_usd
  FROM order_items oi
  WHERE oi.item_source = 'local'
  GROUP BY oi.order_id
) li ON li.order_id = o.id
LEFT JOIN (
  -- IMPORTED rows only: the upstream total carries the base qty; edits and
  -- removals bill their delta on top (negative when reduced)
  SELECT oi.order_id,
         SUM(((CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) - oi.qty) * oi.unit_price_usd) AS item_delta_usd
  FROM order_items oi
  WHERE oi.item_source = 'import'
    AND (oi.qty_override IS NOT NULL OR oi.removed_at IS NOT NULL)
  GROUP BY oi.order_id
) ie ON ie.order_id = o.id
LEFT JOIN order_writeoffs wo ON wo.order_id = o.id
WHERE o.status NOT IN ('cancelled','refunded');

CREATE VIEW v_rail_reconciliation AS
SELECT
  r.group_buy_id,
  r.payment_rail,
  COUNT(*) AS order_count,
  SUM(r.billed_usd) AS billed_usd,
  SUM(r.comp_usd) AS comp_usd,
  SUM(r.writeoff_usd) AS writeoff_usd,
  SUM(r.effective_received_usd) AS received_usd,
  SUM(r.due_usd) - SUM(r.effective_received_usd) AS gap_usd
FROM v_order_reconciliation r
GROUP BY r.group_buy_id, r.payment_rail;

-- ---- P&L: comp deduction on effective qty (fee columns unchanged) ----
CREATE VIEW v_group_buy_pnl AS
SELECT
  gb.id AS group_buy_id,
  gb.name AS group_buy_name,
  COALESCE(prod.expected_revenue_usd, 0) AS product_revenue_usd,
  COALESCE(ord.order_count, 0) AS order_count,
  COALESCE(ord.admin_fees_usd, 0) AS admin_fee_revenue_usd,
  COALESCE(ord.shipping_fees_usd, 0) AS shipping_fee_revenue_usd,
  COALESCE(ord.insurance_usd, 0) AS insurance_revenue_usd,
  COALESCE(ord.tips_usd, 0) AS tip_revenue_usd,
  COALESCE(cmp.comps_usd, 0) AS comps_usd,
  COALESCE(wo.writeoffs_usd, 0) AS writeoffs_usd,
  COALESCE(adjb.adj_both_usd, 0) AS adj_both_usd,
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(cmp.comps_usd, 0) - COALESCE(wo.writeoffs_usd, 0)
    - COALESCE(adjb.adj_both_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0)
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
    SUM(COALESCE(admin_fee_override_usd, admin_fee_usd)) AS admin_fees_usd,
    SUM(COALESCE(shipping_fee_override_usd, shipping_fee_usd)) AS shipping_fees_usd,
    SUM(COALESCE(shipping_insurance_override_usd, shipping_insurance_usd)) AS insurance_usd,
    SUM(COALESCE(tip_override_usd, tip_usd)) AS tips_usd
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
  SELECT o.group_buy_id,
         SUM(LEAST(oi.comp_qty, CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) * oi.unit_price_usd) AS comps_usd
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
