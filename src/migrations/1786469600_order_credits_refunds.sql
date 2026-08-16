-- Customer credits and refunds — the two money primitives the 2026-MB5-580
-- scenario needs:
--
--  order_credits: a deliberate price reduction agreed with the customer
--  (goodwill, negotiated adjustment). Reduces DUE like a comp — it is money
--  we will never receive and P&L must book it as a revenue deduction — but
--  unlike a write-off it is independent of payment state: it never
--  auto-clears when money lands, and it applies before any payment math.
--  Multiple credits per order, each with a required reason, fully audited.
--
--  order_refunds: money RETURNED from us to the customer (or their lender)
--  after an overpayment. Reduces EFFECTIVE RECEIVED, is capped at the
--  current overpay by the action (typo guard), and — when tied to a wallet —
--  participates in the rail cards' expected-balance math exactly like vendor
--  payouts, so returned crypto never reads as missing customer money.
--
--  Recon becomes:  due      = billed − comps − credits − write-off
--                  received = COALESCE(override, verified) − refunds

CREATE TABLE order_credits (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_usd NUMERIC(12,2) NOT NULL CHECK (amount_usd > 0),
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_credits_order_idx ON order_credits (order_id);

CREATE TABLE order_refunds (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_usd NUMERIC(12,2) NOT NULL CHECK (amount_usd > 0),
  method payment_method NOT NULL,
  wallet_id BIGINT REFERENCES wallets(id),
  tx_ref TEXT,
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_refunds_order_idx ON order_refunds (order_id);
CREATE INDEX order_refunds_wallet_idx ON order_refunds (wallet_id);

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
  COALESCE(cr.credits_usd, 0) AS credits_usd,
  COALESCE(wo.amount_usd, 0) AS writeoff_usd,
  COALESCE(rf.refunds_usd, 0) AS refunds_usd,
  o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0) AS due_usd,
  COALESCE(pv.verified_usd, 0) AS received_usd,
  ov.override_usd,
  COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) - COALESCE(rf.refunds_usd, 0) AS effective_received_usd,
  (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0)) - (COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) - COALESCE(rf.refunds_usd, 0)) AS diff_usd,
  COALESCE(pp.pending_count, 0) AS pending_payment_count,
  CASE
    WHEN COALESCE(pv.verified_usd, 0) = 0 AND ov.override_usd IS NULL
         AND (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0)) > gb.reconcile_tolerance_usd THEN 'awaiting'
    WHEN ABS((o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0)) - (COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) - COALESCE(rf.refunds_usd, 0))) <= gb.reconcile_tolerance_usd THEN 'matched'
    WHEN (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0)) > (COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) - COALESCE(rf.refunds_usd, 0)) THEN 'short'
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
  SELECT oi.order_id,
         SUM(LEAST(oi.comp_qty, CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) * oi.unit_price_usd) AS comp_usd
  FROM order_items oi
  WHERE oi.comp_qty > 0
  GROUP BY oi.order_id
) cp ON cp.order_id = o.id
LEFT JOIN (
  SELECT order_id, SUM(amount_usd) AS credits_usd
  FROM order_credits
  GROUP BY order_id
) cr ON cr.order_id = o.id
LEFT JOIN (
  SELECT order_id, SUM(amount_usd) AS refunds_usd
  FROM order_refunds
  GROUP BY order_id
) rf ON rf.order_id = o.id
LEFT JOIN (
  SELECT oi.order_id,
         SUM(CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END * oi.unit_price_usd) AS local_usd
  FROM order_items oi
  WHERE oi.item_source = 'local'
  GROUP BY oi.order_id
) li ON li.order_id = o.id
LEFT JOIN (
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
  SUM(r.credits_usd) AS credits_usd,
  SUM(r.writeoff_usd) AS writeoff_usd,
  SUM(r.refunds_usd) AS refunds_usd,
  SUM(r.effective_received_usd) AS received_usd,
  SUM(r.due_usd) - SUM(r.effective_received_usd) AS gap_usd
FROM v_order_reconciliation r
GROUP BY r.group_buy_id, r.payment_rail;

-- P&L: credits are revenue that will never arrive, exactly like comps and
-- write-offs. Refunds deliberately do NOT touch P&L — they return overpaid
-- money, not revenue.
DROP VIEW IF EXISTS v_group_buy_pnl;

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
  COALESCE(cred.credits_usd, 0) AS credits_usd,
  COALESCE(wo.writeoffs_usd, 0) AS writeoffs_usd,
  COALESCE(adjb.adj_both_usd, 0) AS adj_both_usd,
  COALESCE(prod.expected_revenue_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0)
    - COALESCE(adjb.adj_both_usd, 0) AS total_revenue_usd,
  COALESCE(prod.product_profit_usd, 0) AS product_profit_usd,
  COALESCE(exp.expenses_usd, 0) AS expenses_usd,
  COALESCE(ship.label_costs_usd, 0) AS label_costs_usd,
  COALESCE(prod.product_profit_usd, 0) + COALESCE(ord.admin_fees_usd, 0)
    + COALESCE(ord.shipping_fees_usd, 0) + COALESCE(ord.insurance_usd, 0) + COALESCE(ord.tips_usd, 0)
    - COALESCE(exp.expenses_usd, 0) - COALESCE(ship.label_costs_usd, 0)
    - COALESCE(cmp.comps_usd, 0) - COALESCE(cred.credits_usd, 0) - COALESCE(wo.writeoffs_usd, 0)
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
  SELECT o.group_buy_id, SUM(oc.amount_usd) AS credits_usd
  FROM order_credits oc
  JOIN orders o ON o.id = oc.order_id
  WHERE o.status NOT IN ('cancelled','refunded')
  GROUP BY o.group_buy_id
) cred ON cred.group_buy_id = gb.id
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
