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
             -- it): the ORDER-TIME SNAPSHOT on each line is summed here, so a
             -- later campaign-config fee change never rewrites this order
             (SELECT COALESCE(SUM(oi2.split_fee_usd), 0)
              FROM order_items oi2
              WHERE oi2.order_id = o.id AND oi2.removed_at IS NULL
                AND oi2.split_fee_usd > 0) AS split_fee_usd
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      WHERE o.id = {{params.order_id}}::bigint
    `,
  });
}

export default getOrder;
