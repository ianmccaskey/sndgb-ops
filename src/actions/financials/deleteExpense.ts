import { action } from '@uibakery/data';

function deleteExpense() {
  return action('deleteExpense', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `DELETE FROM expenses WHERE id = {{params.id}}::bigint RETURNING id`,
  });
}

export default deleteExpense;
