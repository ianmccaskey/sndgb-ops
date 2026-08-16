-- A REMOVED split (half-kit) line releases its charged split fee from
-- billed: the fee lives inside total_usd, so the item-delta for a removed
-- line subtracts qty x price AND the line's snapshotted fee — matching the
-- push, which reduces the upstream total by both when the removal lands.
-- (Whole<->half transitions are refused locally, so removal/restore is the
-- only local path that moves a fee.)

CREATE OR REPLACE VIEW v_order_reconciliation AS
SELECT o.id AS order_id,
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
  o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0) - (COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) - COALESCE(rf.refunds_usd, 0)) AS diff_usd,
  COALESCE(pp.pending_count, 0) AS pending_payment_count,
  CASE
    WHEN COALESCE(pv.verified_usd, 0) = 0 AND ov.override_usd IS NULL AND (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0)) > gb.reconcile_tolerance_usd THEN 'awaiting'
    WHEN ABS(o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0) - (COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) - COALESCE(rf.refunds_usd, 0))) <= gb.reconcile_tolerance_usd THEN 'matched'
    WHEN (o.total_usd + COALESCE(li.local_usd, 0) + fd.fee_delta_usd + COALESCE(ie.item_delta_usd, 0) - COALESCE(cp.comp_usd, 0) - COALESCE(cr.credits_usd, 0) - COALESCE(wo.amount_usd, 0)) > (COALESCE(ov.override_usd, COALESCE(pv.verified_usd, 0)) - COALESCE(rf.refunds_usd, 0)) THEN 'short'
    ELSE 'over'
  END AS recon_status
FROM orders o
CROSS JOIN LATERAL (
  SELECT COALESCE(o.admin_fee_override_usd, o.admin_fee_usd) - o.admin_fee_usd
       + (COALESCE(o.shipping_fee_override_usd, o.shipping_fee_usd) - o.shipping_fee_usd)
       + (COALESCE(o.shipping_insurance_override_usd, o.shipping_insurance_usd) - o.shipping_insurance_usd)
       + (COALESCE(o.tip_override_usd, o.tip_usd) - o.tip_usd) AS fee_delta_usd
) fd
JOIN group_buys gb ON gb.id = o.group_buy_id
JOIN customers c ON c.id = o.customer_id
LEFT JOIN (
  SELECT payments.order_id, SUM(payments.amount_usd) AS verified_usd
  FROM payments WHERE payments.status = 'verified'
  GROUP BY payments.order_id
) pv ON pv.order_id = o.id
LEFT JOIN (
  SELECT payments.order_id, COUNT(*) AS pending_count
  FROM payments WHERE payments.status = 'pending'
  GROUP BY payments.order_id
) pp ON pp.order_id = o.id
LEFT JOIN LATERAL (
  SELECT po.amount_usd AS override_usd
  FROM payment_overrides po
  WHERE po.order_id = o.id
  ORDER BY po.created_at DESC LIMIT 1
) ov ON true
LEFT JOIN (
  SELECT oi.order_id,
         SUM(LEAST(oi.comp_qty, CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) * oi.unit_price_usd) AS comp_usd
  FROM order_items oi WHERE oi.comp_qty > 0
  GROUP BY oi.order_id
) cp ON cp.order_id = o.id
LEFT JOIN (
  SELECT order_credits.order_id, SUM(order_credits.amount_usd) AS credits_usd
  FROM order_credits GROUP BY order_credits.order_id
) cr ON cr.order_id = o.id
LEFT JOIN (
  SELECT order_refunds.order_id, SUM(order_refunds.amount_usd) AS refunds_usd
  FROM order_refunds GROUP BY order_refunds.order_id
) rf ON rf.order_id = o.id
LEFT JOIN (
  SELECT oi.order_id,
         SUM(CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END * oi.unit_price_usd) AS local_usd
  FROM order_items oi WHERE oi.item_source = 'local'
  GROUP BY oi.order_id
) li ON li.order_id = o.id
LEFT JOIN (
  SELECT oi.order_id,
         SUM((CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END - oi.qty) * oi.unit_price_usd
             -- a removed line's charged split fee leaves billed with it
             - CASE WHEN oi.removed_at IS NOT NULL THEN oi.split_fee_usd ELSE 0 END) AS item_delta_usd
  FROM order_items oi
  WHERE oi.item_source = 'import' AND (oi.qty_override IS NOT NULL OR oi.removed_at IS NOT NULL)
  GROUP BY oi.order_id
) ie ON ie.order_id = o.id
LEFT JOIN order_writeoffs wo ON wo.order_id = o.id
WHERE o.status NOT IN ('cancelled', 'refunded');
