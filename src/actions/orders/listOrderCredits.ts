import { action } from '@uibakery/data';

function listOrderCredits() {
  return action('listOrderCredits', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, amount_usd, reason, created_by, created_at
      FROM order_credits
      WHERE order_id = {{params.order_id}}::bigint
      ORDER BY created_at
    `,
  });
}

export default listOrderCredits;
