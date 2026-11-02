import { action } from '@uibakery/data';

/**
 * Every shipment of one order — drafts, finalized, refunded — newest last,
 * with its attributed items aggregated. Voided rows (refund SUCCESS) are
 * INCLUDED so history stays visible; consumers style them struck-through
 * and all fulfilled math already excludes them server-side. Cancelled
 * boxes (cancelled_at) are included the same way — their items are empty.
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
             s.tracking_status, s.tracking_substatus, s.tracking_status_date, s.tracking_checked_at, s.tracking_error, s.eta,
             s.shippo_order_id,
             btrim(COALESCE(s.destination->>'email', '')) AS dest_email,
             s.purchase_started_at, s.purchase_attempted_at, s.attempt_verified_no_label_at,
             s.finalized_at, s.shipped_at, s.b44_pushed_at, s.push_epoch, s.created_by, s.created_at,
             -- recorded shipped by mistake (1790103200): the box is empty,
             -- cancelled_items is what it held
             s.cancelled_at, s.cancelled_by, s.cancel_reason,
             COALESCE(s.cancelled_items, '[]'::jsonb) AS cancelled_items, s.upstream_reset_at,
             -- the ordering-app status this box's push found (recorded
             -- since 2026-11-01) — what a reset restores by default
             (SELECT al.new_data->'pushed'->>'prior_status' FROM audit_log al
              WHERE al.table_name = 'shipments' AND al.row_pk = s.id::text
                AND al.action = 'shipment_pushed_upstream'
              ORDER BY al.id DESC LIMIT 1) AS pushed_prior_status,
             -- a MANUAL order's address changes only by setManualOrderAddress,
             -- so a box whose label snapshot differs was made for an earlier
             -- ship-to: the old street and city, else NULL (imported orders'
             -- addresses move with every pull — not flagged)
             CASE WHEN o.external_id IS NULL AND o.raw_import->>'source' = 'manual'
                   AND s.destination ? 'street1'
                   AND (COALESCE(s.destination->>'street1', '') <> COALESCE(o.address_line1, '')
                     OR COALESCE(s.destination->>'street2', '') <> COALESCE(o.address_line2, '')
                     OR COALESCE(s.destination->>'city', '')    <> COALESCE(o.city, '')
                     OR COALESCE(s.destination->>'state', '')   <> COALESCE(o.state_code, '')
                     OR COALESCE(s.destination->>'zip', '')     <> COALESCE(o.postal_code, ''))
                  THEN concat_ws(', ', NULLIF(s.destination->>'street1', ''), NULLIF(s.destination->>'city', ''))
             END AS dest_differs,
             COALESCE(si.items, '[]'::jsonb) AS items
      FROM shipments s
      JOIN orders o ON o.id = s.order_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'order_item_id', si.order_item_id,
                 'qty', si.qty,
                 'sku_code', p.sku_code,
                 'product_id', p.id,
                 'product_external_id', cpl.external_id) ORDER BY p.sku_code) AS items
        FROM shipment_items si
        JOIN order_items oi ON oi.id = si.order_item_id
        JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
        JOIN products p ON p.id = gbp.product_id
        -- ordering-app product id in this order's campaign (1790101900)
        LEFT JOIN campaign_product_links cpl
          ON cpl.group_buy_id = gbp.group_buy_id AND cpl.product_id = p.id
        WHERE si.shipment_id = s.id
      ) si ON true
      WHERE s.order_id = {{params.order_id}}::bigint
      ORDER BY s.created_at
    `,
  });
}

export default listOrderShipments;
