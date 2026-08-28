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
        -- 42001, so this figure cannot move before the insert commits.
        -- POST-CLEAR overpay: this action auto-clears a standing write-off,
        -- which raises due by writeoff_usd — capping on the pre-clear
        -- diff_usd would let a refund through that leaves the order short
        -- by the cleared write-off once the delete below commits
        SELECT GREATEST(-(r.diff_usd + r.writeoff_usd), 0) AS max_refund
        FROM lck, v_order_reconciliation r
        WHERE r.order_id = {{params.order_id}}::bigint
      ), ins AS (
        INSERT INTO order_refunds (order_id, amount_usd, method, wallet_id, tx_ref, reason, created_by)
        SELECT o.id, {{params.amount_usd}}::numeric, {{params.method}}::payment_method,
               NULLIF({{params.wallet_id}}::text, '')::bigint,
               NULLIF({{params.tx_ref}}::text, ''),
               TRIM({{params.reason}}::text), {{params.actor}}::text
        FROM cap, orders o
        WHERE o.id = {{params.order_id}}::bigint
          AND o.status NOT IN ('cancelled', 'refunded')
          AND ({{params.amount_usd}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.amount_usd}})::numeric > 0
          AND ({{params.amount_usd}})::numeric <= cap.max_refund
          AND LENGTH(TRIM({{params.reason}}::text)) > 0
          -- the refund rail must MATCH the order's rail: the recon view
          -- subtracts refunds from received on the ORDER's rail while the
          -- rail cards attribute wallet outflows by chain — a cross-rail
          -- refund would reduce one card's received and show the outflow on
          -- another, fabricating drift on both
          AND ((({{params.method}})::text IN ('eth', 'sol', 'base') AND o.payment_rail::text = ({{params.method}})::text)
               OR (({{params.method}})::text NOT IN ('eth', 'sol', 'base') AND o.payment_rail::text = 'cash'))
          -- the wallet (when given) must exist AND its chain must match the
          -- refund method: rail cards attribute wallet-linked refunds by
          -- wallet chain, so a mismatched wallet would move the outflow onto
          -- the wrong rail card. Crypto methods need the same-chain wallet;
          -- P2P/cash methods need a fiat wallet (or none).
          AND (NULLIF({{params.wallet_id}}::text, '') IS NULL OR EXISTS (
            SELECT 1 FROM wallets w
            WHERE w.id = NULLIF({{params.wallet_id}}::text, '')::bigint
              AND ((({{params.method}})::text IN ('eth', 'sol', 'base') AND w.chain::text = ({{params.method}})::text)
                   OR (({{params.method}})::text NOT IN ('eth', 'sol', 'base') AND w.chain = 'fiat'))
          ))
        RETURNING id, order_id, amount_usd, method, wallet_id, tx_ref, reason
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING ins
        WHERE w.order_id = {{params.order_id}}::bigint
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}}::text,
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'refund_added')
        FROM wo_clear
        RETURNING row_pk
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_refunds', ins.id::text, 'order_refund_added', {{params.actor}}::text,
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
