import { action } from '@uibakery/data';

function getOrder() {
  return action('getOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.*, c.display_name AS customer_name, c.email AS customer_email,
             r.recon_status, r.received_usd, r.override_usd, r.effective_received_usd, r.diff_usd,
             r.comp_usd, r.writeoff_usd, r.due_usd, r.pending_payment_count,
             r.credits_usd, r.refunds_usd,
             -- split-kit fee already inside total_usd (the ordering app adds
             -- it): decomposed here so the fee box can show its own line
             (SELECT COALESCE(SUM(gbp2.split_fee_usd), 0)
              FROM order_items oi2
              JOIN group_buy_products gbp2 ON gbp2.id = oi2.group_buy_product_id
              WHERE oi2.order_id = o.id AND oi2.removed_at IS NULL
                AND COALESCE(oi2.qty_override, oi2.qty) % 1 <> 0
                AND gbp2.split_fee_usd > 0) AS split_fee_usd
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      WHERE o.id = {{params.order_id}}::bigint
    `,
  });
}

export default getOrder;
