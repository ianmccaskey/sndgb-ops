-- Write-offs: forgive a small residual shortfall on an order (fee dust,
-- rounding, a customer a few dollars short) so it stops reading 'short'
-- forever — while the forgiven value stays visible everywhere money is
-- reported. One ACTIVE write-off per order (UNIQUE): multiple stacked rows
-- could silently double-forgive; editing replaces, clearing deletes, and
-- the audit_log keeps the history.
--
-- Reconciliation: due = billed - comps - write-off (recon_status compares
-- received against that). P&L: writeoffs_usd is a deduction in total
-- revenue and net profit, exactly like comps — expected money that will
-- never arrive.

CREATE TABLE order_writeoffs (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  amount_usd NUMERIC(12,2) NOT NULL CHECK (amount_usd > 0),
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  o.total_usd AS billed_usd,
  COALESCE(cp.comp_usd, 0) AS comp_usd,
  COALESCE(wo.amount_usd, 0) AS writeoff_usd,
  o.total_usd - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0) AS due_usd,
  COALESCE(pv.verified_usd, 0) AS received_usd,
  ov.override_usd,
  COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS effective_received_usd,
  (o.total_usd - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS diff_usd,
  COALESCE(pp.pending_count, 0) AS pending_payment_count,
  CASE
    WHEN COALESCE(pv.verified_usd, 0) = 0 AND ov.override_usd IS NULL
         AND (o.total_usd - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) > gb.reconcile_tolerance_usd THEN 'awaiting'
    WHEN ABS((o.total_usd - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0))) <= gb.reconcile_tolerance_usd THEN 'matched'
    WHEN (o.total_usd - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) > COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) THEN 'short'
    ELSE 'over'
  END AS recon_status
FROM orders o
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
  SELECT oi.order_id, SUM(LEAST(oi.comp_qty, oi.qty) * oi.unit_price_usd) AS comp_usd
  FROM order_items oi
  WHERE oi.comp_qty > 0
  GROUP BY oi.order_id
) cp ON cp.order_id = o.id
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
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(cmp.comps_usd, 0) - COALESCE(wo.writeoffs_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0)
    - COALESCE(cmp.comps_usd, 0) - COALESCE(wo.writeoffs_usd, 0) AS net_profit_usd
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
) wo ON wo.group_buy_id = gb.id;
