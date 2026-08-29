import { action } from '@uibakery/data';

/**
 * Flip a product's DIGITAL flag (COA certificates: billed but never
 * packed/shipped — excluded from all fulfillment math). CAS on the value
 * the editor saw (same pattern as setProductWeight): a stale toggle
 * refuses instead of silently double-flipping against the other admin.
 * Audited old/new.
 */
function setProductDigital() {
  return action('setProductDigital', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE products p
        SET digital = {{params.digital}}::boolean
        WHERE p.id = {{params.product_id}}::bigint
          AND p.digital = {{params.expected_digital}}::boolean
        RETURNING p.id, p.sku_code, p.digital
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
      SELECT 'products', up.id::text, 'product_digital_set', {{params.actor}}::text,
             jsonb_build_object('digital', {{params.expected_digital}}::boolean),
             jsonb_build_object('sku_code', up.sku_code, 'digital', up.digital)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default setProductDigital;
