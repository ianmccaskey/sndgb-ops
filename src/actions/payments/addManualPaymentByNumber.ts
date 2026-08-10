import { action } from '@uibakery/data';

/**
 * Record a manual (P2P/cash) payment by campaign + order number in ONE
 * statement: the order is resolved and the payment inserted atomically, with
 * cancelled/refunded orders excluded in the same query — no lookup-then-insert
 * race can attach a payment to an order reconciliation can't see.
 * Returns inserted = 0 when the order number doesn't match an eligible order.
 */
function addManualPaymentByNumber() {
  return action('addManualPaymentByNumber', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH target AS (
        SELECT id FROM orders
        WHERE group_buy_id = {{params.group_buy_id}}::bigint
          AND order_number = TRIM({{params.order_number}})
          AND status NOT IN ('cancelled','refunded')
        LIMIT 1
      ), ins AS (
        INSERT INTO payments (order_id, method, tx_hash, receipt_ref, amount_usd, status, verify_source, verified_at, notes)
        SELECT target.id,
               {{params.method}}::payment_method,
               NULLIF({{params.tx_hash}}::text, ''),
               NULLIF({{params.receipt_ref}}::text, ''),
               {{params.amount_usd}}::numeric,
               'verified',
               'manual',
               now(),
               NULLIF({{params.notes}}::text, '')
        FROM target
        RETURNING id, order_id, amount_usd, method
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'payments', ins.id::text, 'manual_payment', {{params.actor}},
               jsonb_build_object('order_id', ins.order_id, 'amount_usd', ins.amount_usd, 'method', ins.method)
        FROM ins
        RETURNING row_pk
      )
      SELECT (SELECT COUNT(*) FROM ins) AS inserted
    `,
  });
}

export default addManualPaymentByNumber;
