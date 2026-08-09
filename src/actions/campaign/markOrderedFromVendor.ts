import { action } from '@uibakery/data';

function markOrderedFromVendor() {
  return action('markOrderedFromVendor', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE group_buy_products
      SET ordered_from_vendor_at = CASE WHEN {{params.ordered}}::boolean THEN now() ELSE NULL END
      WHERE id = {{params.group_buy_product_id}}::bigint
      RETURNING id
    `,
  });
}

export default markOrderedFromVendor;
