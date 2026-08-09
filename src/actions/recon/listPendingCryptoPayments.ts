import { action } from '@uibakery/data';

/** Pending crypto payments (have a tx hash) for the bulk "Verify all" flow. */
function listPendingCryptoPayments() {
  return action('listPendingCryptoPayments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT p.id AS payment_id, p.method, p.tx_hash, o.id AS order_id,
             o.order_number, o.total_usd, c.display_name AS customer_name
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND p.status = 'pending'
        AND p.tx_hash IS NOT NULL
      ORDER BY o.order_number
      LIMIT 200
    `,
  });
}

export default listPendingCryptoPayments;
