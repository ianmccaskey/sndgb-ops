import { action } from '@uibakery/data';

/**
 * Flip a product's DIGITAL flag (COA certificates: billed but never
 * packed/shipped — excluded from all fulfillment math). CAS on the value
 * the editor saw (same pattern as setProductWeight): a stale toggle
 * refuses instead of silently double-flipping against the other admin.
 * Flipping TO digital refuses while any non-voided shipment holds
 * attributed quantity of this product — a box already physically
 * contains it, and hiding the line mid-flight would strand real packed
 * work and mis-derive order shipped states; void/refund those shipments
 * first. (Lines with merely REMAINING work don't block — hiding those is
 * exactly what marking a certificate digital is for.) Audited old/new.
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
          AND ({{params.digital}}::boolean = false OR NOT EXISTS (
            SELECT 1 FROM shipment_items si
            JOIN shipments sh ON sh.id = si.shipment_id
              AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
            JOIN order_items oi ON oi.id = si.order_item_id
            JOIN group_buy_products g ON g.id = oi.group_buy_product_id
            WHERE g.product_id = p.id))
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
