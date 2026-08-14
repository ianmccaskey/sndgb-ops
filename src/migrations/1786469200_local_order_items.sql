-- Locally added order items: the ordering app can stop accepting item
-- changes (ordering closed) while this app — the fulfillment source of
-- truth — still needs to record what a customer is actually getting.
--
-- item_source 'local' rows:
--  - are NEVER pruned by imports (deleteOrderItemsNotIn skips them) and
--    never qty-reset by pulls (the upsert only fires on upstream SKUs);
--  - ADD to what the customer owes: reconciliation bills
--    total_usd + local items value (qty × gb price), so the extra payment
--    is expected rather than reading as an overpayment;
--  - are ADOPTED by an import if the same SKU later appears upstream
--    (item_source flips to 'import', upstream qty wins, the header total
--    from upstream then carries the money) — recording here first and
--    fixing the ordering app later converges cleanly.

ALTER TABLE order_items ADD COLUMN item_source TEXT NOT NULL DEFAULT 'import'
  CHECK (item_source IN ('import', 'local'));

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
  o.total_usd + COALESCE(li.local_usd, 0) AS billed_usd,
  COALESCE(li.local_usd, 0) AS local_items_usd,
  COALESCE(cp.comp_usd, 0) AS comp_usd,
  COALESCE(wo.amount_usd, 0) AS writeoff_usd,
  o.total_usd + COALESCE(li.local_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0) AS due_usd,
  COALESCE(pv.verified_usd, 0) AS received_usd,
  ov.override_usd,
  COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS effective_received_usd,
  (o.total_usd + COALESCE(li.local_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) AS diff_usd,
  COALESCE(pp.pending_count, 0) AS pending_payment_count,
  CASE
    WHEN COALESCE(pv.verified_usd, 0) = 0 AND ov.override_usd IS NULL
         AND (o.total_usd + COALESCE(li.local_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) > gb.reconcile_tolerance_usd THEN 'awaiting'
    WHEN ABS((o.total_usd + COALESCE(li.local_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) - COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0))) <= gb.reconcile_tolerance_usd THEN 'matched'
    WHEN (o.total_usd + COALESCE(li.local_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(wo.amount_usd, 0)) > COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) THEN 'short'
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
LEFT JOIN (
  SELECT oi.order_id, SUM(oi.qty * oi.unit_price_usd) AS local_usd
  FROM order_items oi
  WHERE oi.item_source = 'local'
  GROUP BY oi.order_id
) li ON li.order_id = o.id
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
