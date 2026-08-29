import { action } from '@uibakery/data';

/**
 * Flip a product's DIGITAL flag via set_product_digital() (migration
 * 1786474000): a plpgsql fn so its statements read FRESH snapshots after
 * waiting on the shared per-product advisory lock (42007) — the same lock
 * the shipment-creation fns take for every product on an order, which is
 * what makes the flip-vs-pack race safe in BOTH directions (a flip behind
 * an in-flight draft sees the new attribution and refuses; a draft behind
 * an in-flight flip sees digital=true and refuses the line). Also CASes
 * on the value the editor saw, and refuses digital=true while any
 * non-voided shipment holds attributed quantity of the product. Audited.
 */
function setProductDigital() {
  return action('setProductDigital', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM set_product_digital(
        {{params.product_id}}::bigint,
        {{params.digital}}::boolean,
        {{params.expected_digital}}::boolean,
        {{params.actor}}::text
      )
    `,
  });
}

export default setProductDigital;
