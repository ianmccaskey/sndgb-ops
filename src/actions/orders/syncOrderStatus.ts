import { action } from '@uibakery/data';

/**
 * Applies an upstream terminal status (cancelled/refunded) to an existing
 * local order. Import never overwrites status on upsert (recon owns
 * verified/flagged), so source-side cancellations arrive through this
 * dedicated path. Matching nothing is fine — the order was never imported.
 */
function syncOrderStatus() {
  return action('syncOrderStatus', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE orders SET status = {{params.status}}::order_status
      WHERE order_number = {{params.order_number}}::text
        AND group_buy_id = {{params.group_buy_id}}::bigint
        AND status <> {{params.status}}::order_status
      RETURNING id
    `,
  });
}

export default syncOrderStatus;
