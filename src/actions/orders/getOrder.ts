import { action } from '@uibakery/data';

function getOrder() {
  return action('getOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.*, c.display_name AS customer_name, c.email AS customer_email,
             r.recon_status, r.received_usd, r.override_usd, r.effective_received_usd, r.diff_usd,
             r.comp_usd, r.writeoff_usd, r.due_usd, r.pending_payment_count,
             r.credits_usd, r.refunds_usd
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      WHERE o.id = {{params.order_id}}::bigint
    `,
  });
}

export default getOrder;
