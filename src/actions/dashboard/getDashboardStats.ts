import { action } from '@uibakery/data';

function getDashboardStats() {
  return action('getDashboardStats', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT
        (SELECT COUNT(*) FROM orders o WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
           AND o.status NOT IN ('cancelled','refunded')) AS order_count,
        (SELECT COALESCE(SUM(total_usd),0) FROM orders o WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
           AND o.status NOT IN ('cancelled','refunded')) AS billed_usd,
        (SELECT COALESCE(SUM(effective_received_usd),0) FROM v_order_reconciliation r
           WHERE r.group_buy_id = {{params.group_buy_id}}::bigint) AS received_usd,
        -- due = billed minus comped (free) items; collection health must use
        -- this denominator or fully-settled comped campaigns look short
        (SELECT COALESCE(SUM(due_usd),0) FROM v_order_reconciliation r
           WHERE r.group_buy_id = {{params.group_buy_id}}::bigint) AS due_usd,
        (SELECT COALESCE(SUM(comp_usd),0) FROM v_order_reconciliation r
           WHERE r.group_buy_id = {{params.group_buy_id}}::bigint) AS comp_usd,
        (SELECT COALESCE(SUM(writeoff_usd),0) FROM v_order_reconciliation r
           WHERE r.group_buy_id = {{params.group_buy_id}}::bigint) AS writeoff_usd,
        (SELECT COUNT(*) FROM v_order_reconciliation r
           WHERE r.group_buy_id = {{params.group_buy_id}}::bigint AND r.recon_status = 'short') AS short_count,
        (SELECT COUNT(*) FROM v_order_reconciliation r
           WHERE r.group_buy_id = {{params.group_buy_id}}::bigint AND r.recon_status = 'awaiting') AS awaiting_count,
        (SELECT COUNT(*) FROM v_order_reconciliation r
           WHERE r.group_buy_id = {{params.group_buy_id}}::bigint AND r.recon_status = 'over') AS over_count,
        (SELECT COUNT(*) FROM orders o WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
           AND o.hold_shipping AND o.status NOT IN ('cancelled','refunded')) AS held_count,
        (SELECT COALESCE(SUM(balance_usd),0) FROM v_vendor_balances vb
           WHERE vb.group_buy_id = {{params.group_buy_id}}::bigint AND vb.balance_usd > 0) AS owed_to_vendors_usd,
        (SELECT COUNT(*) FROM v_vendor_balances vb
           WHERE vb.group_buy_id = {{params.group_buy_id}}::bigint AND vb.pay_status = 'OVERPAID') AS overpaid_vendor_count,
        (SELECT COALESCE(SUM(net_profit_usd),0) FROM v_group_buy_pnl pnl
           WHERE pnl.group_buy_id = {{params.group_buy_id}}::bigint) AS net_profit_usd,
        (SELECT COUNT(*) FROM payments p JOIN orders o ON o.id = p.order_id
           WHERE o.group_buy_id = {{params.group_buy_id}}::bigint AND p.status = 'pending' AND p.tx_hash IS NOT NULL) AS pending_crypto_count
    `,
  });
}

export default getDashboardStats;
