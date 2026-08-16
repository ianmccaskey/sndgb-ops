import { action } from '@uibakery/data';

/**
 * Record money RETURNED to the customer (or whoever fronted their payment)
 * from an overpaid order. Reduces effective received; when tied to a wallet
 * it participates in the rail cards' expected-balance math like a vendor
 * payout, so returned crypto never reads as missing customer money.
 *
 * CAPPED at the current overpay, computed in-transaction under the 42001
 * lock from the recon view (a typo — 15660 for 1566 — must refuse, not
 * turn the order 'short'). Guards: active order; amount positive, max 2
 * decimals; a non-empty reason; the wallet (when given) must exist.
 * A standing write-off auto-clears (received moved).
 */
function addOrderRefund() {
  return action('addOrderRefund', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), cap AS (
        -- overpay under the lock: every due/received writer serializes on
        -- 42001, so this figure cannot move before the insert commits
        SELECT GREATEST(-r.diff_usd, 0) AS max_refund
        FROM lck, v_order_reconciliation r
        WHERE r.order_id = {{params.order_id}}::bigint
      ), ins AS (
        INSERT INTO order_refunds (order_id, amount_usd, method, wallet_id, tx_ref, reason, created_by)
        SELECT o.id, {{params.amount_usd}}::numeric, {{params.method}}::payment_method,
               NULLIF({{params.wallet_id}}::text, '')::bigint,
               NULLIF({{params.tx_ref}}::text, ''),
               TRIM({{params.reason}}), {{params.actor}}
        FROM cap, orders o
        WHERE o.id = {{params.order_id}}::bigint
          AND o.status NOT IN ('cancelled', 'refunded')
          AND ({{params.amount_usd}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.amount_usd}})::numeric > 0
          AND ({{params.amount_usd}})::numeric <= cap.max_refund
          AND LENGTH(TRIM({{params.reason}})) > 0
          AND (NULLIF({{params.wallet_id}}::text, '') IS NULL OR EXISTS (
            SELECT 1 FROM wallets w WHERE w.id = NULLIF({{params.wallet_id}}::text, '')::bigint
          ))
        RETURNING id, order_id, amount_usd, method, wallet_id, tx_ref, reason
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING ins
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'refund_added')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_refunds', ins.id::text, 'order_refund_added', {{params.actor}},
             jsonb_build_object('order_id', ins.order_id, 'amount_usd', ins.amount_usd,
                                'method', ins.method, 'wallet_id', ins.wallet_id,
                                'tx_ref', ins.tx_ref, 'reason', ins.reason,
                                'max_refund_at_insert', (SELECT max_refund FROM cap))
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addOrderRefund;
