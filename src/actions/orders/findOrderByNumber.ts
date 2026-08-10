import { action } from '@uibakery/data';

/**
 * Resolve an order id from its number within one campaign, independent of any
 * UI filtering. Used by the manual-payment form so recording a cash payment
 * works regardless of the recon table's status/rail filters.
 */
function findOrderByNumber() {
  return action('findOrderByNumber', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, order_number, status
      FROM orders
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
        AND order_number = TRIM({{params.order_number}})
      LIMIT 1
    `,
  });
}

export default findOrderByNumber;
