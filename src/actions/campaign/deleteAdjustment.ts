import { action } from '@uibakery/data';

/**
 * Delete an adjustment. A RECEIVED at-cost row is refused (zero rows):
 * deleting it would erase a real customer payment's record along with the
 * demand and the P&L waiver during routine cleanup — the audited trail
 * (at_cost_payment_received) must keep its subject. Unreceived at-cost rows
 * delete freely (the sale fell through: demand, waiver, and receivable all
 * leave together, which is exactly right).
 */
function deleteAdjustment() {
  return action('deleteAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      DELETE FROM admin_adjustments
      WHERE id = {{params.id}}::bigint
        AND NOT (pricing = 'cost' AND received_at IS NOT NULL)
      RETURNING id
    `,
  });
}

export default deleteAdjustment;
