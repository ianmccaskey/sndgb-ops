import { action } from '@uibakery/data';

function deleteAdjustment() {
  return action('deleteAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `DELETE FROM admin_adjustments WHERE id = {{params.id}}::bigint RETURNING id`,
  });
}

export default deleteAdjustment;
