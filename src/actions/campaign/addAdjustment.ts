import { action } from '@uibakery/data';

function addAdjustment() {
  return action('addAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO admin_adjustments (group_buy_product_id, qty, reason, created_by)
      VALUES (
        {{params.group_buy_product_id}}::bigint,
        {{params.qty}}::int,
        {{params.reason}},
        {{params.created_by}}
      )
      RETURNING id
    `,
  });
}

export default addAdjustment;
