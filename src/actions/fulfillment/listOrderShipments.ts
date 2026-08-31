import { action } from '@uibakery/data';

/**
 * Every shipment of one order — drafts, finalized, refunded — newest last,
 * with its attributed items aggregated. Voided rows (refund SUCCESS) are
 * INCLUDED so history stays visible; consumers style them struck-through
 * and all fulfilled math already excludes them server-side.
 */
function listOrderShipments() {
  return action('listOrderShipments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      -- '#' guard on tracking: 22-digit USPS numbers get rounded by the
      -- JS transport unless they travel with a non-digit char; consumers
      -- strip it at the row boundary (lib/rows dbText)
      SELECT s.id, s.order_id, s.status, s.carrier, s.servicelevel,
             '#' || s.tracking_number AS tracking_number,
             s.label_cost_usd, s.rate_amount, s.rate_currency, s.box, s.note,
             s.from_label, s.parcel, s.label_url,
             s.shippo_rate_id, s.shippo_transaction_id,
             s.refund_status, s.refund_requested_at,
             s.purchase_started_at, s.purchase_attempted_at, s.attempt_verified_no_label_at,
             s.finalized_at, s.shipped_at, s.b44_pushed_at, s.push_epoch, s.created_by, s.created_at,
             COALESCE(si.items, '[]'::jsonb) AS items
      FROM shipments s
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'order_item_id', si.order_item_id,
                 'qty', si.qty,
                 'sku_code', p.sku_code,
                 'product_id', p.id,
                 'product_external_id', p.external_id) ORDER BY p.sku_code) AS items
        FROM shipment_items si
        JOIN order_items oi ON oi.id = si.order_item_id
        JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
        JOIN products p ON p.id = gbp.product_id
        WHERE si.shipment_id = s.id
      ) si ON true
      WHERE s.order_id = {{params.order_id}}::bigint
      ORDER BY s.created_at
    `,
  });
}

export default listOrderShipments;
