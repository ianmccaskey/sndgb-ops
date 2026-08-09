import { action } from '@uibakery/data';

function listExpenses() {
  return action('listExpenses', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, category, description, unit_cost_usd, qty, total_usd, incurred_on, created_at
      FROM expenses
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY created_at DESC
    `,
  });
}

export default listExpenses;
