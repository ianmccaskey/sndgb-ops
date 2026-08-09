import { action } from '@uibakery/data';

function addExpense() {
  return action('addExpense', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO expenses (group_buy_id, category, description, unit_cost_usd, qty, incurred_on)
      VALUES (
        {{params.group_buy_id}}::bigint,
        {{params.category}}::expense_category,
        {{params.description}},
        {{params.unit_cost_usd}}::numeric,
        {{params.qty}}::numeric,
        NULLIF({{params.incurred_on}}::text, '')::date
      )
      RETURNING id
    `,
  });
}

export default addExpense;
