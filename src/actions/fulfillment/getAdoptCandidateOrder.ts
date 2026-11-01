import { action } from '@uibakery/data';

/**
 * ONE order's lines in listAdoptCandidates' exact shape — the auto-adopt
 * pass re-reads them right before (and right after) an ordering-app
 * write-back, so the dates and completion it writes rest on the local
 * record as it is at that moment, not as it was when the run began (an
 * undo of a vendor-shipped mark, a quantity edit or a voided box in
 * between must hold the write back). Keep the two queries identical.
 */
function getAdoptCandidateOrder() {
  return action('getAdoptCandidateOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id AS order_id, o.order_number, o.external_id,
             oi.id AS order_item_id,
             cpl.external_id AS product_external_id,
             p.sku_code, p.digital,
             oi.direct_ship, oi.direct_fulfilled_at,
             oi.direct_vendor_carrier, oi.direct_vendor_tracking,
             COALESCE(oi.qty_override, oi.qty) AS effective_qty,
             COALESCE(att.attributed, 0) AS attributed_qty,
             COALESCE(att.shipped, 0) AS shipped_qty,
             COALESCE(att.adopted, 0) AS adopted_qty,
             COALESCE(att.local_box, 0) AS local_box_qty,
             att.last_shipped_on,
             att.boxes,
             EXISTS (
               SELECT 1 FROM audit_log al
               WHERE al.table_name = 'shipments'
                 AND al.action = 'shipment_pushed_upstream'
                 AND (al.new_data->>'order_id')::bigint = o.id
                 AND al.new_data->'pushed'->>'status_set' = 'shipped') AS completion_logged
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.removed_at IS NULL
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      LEFT JOIN campaign_product_links cpl
        ON cpl.group_buy_id = gbp.group_buy_id AND cpl.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(si.qty), 0) AS attributed,
               COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL), 0) AS shipped,
               COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL AND sh.carrier = 'upstream'), 0) AS adopted,
               COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL AND sh.carrier <> 'upstream'), 0) AS local_box,
               (max(sh.shipped_at) FILTER (WHERE sh.finalized_at IS NOT NULL AND sh.carrier <> 'upstream'))::date::text AS last_shipped_on,
               string_agg(sh.shipped_at::date::text || ' ' || sh.carrier || ' ' || COALESCE(NULLIF(sh.tracking_number, ''), '(no tracking)'), '; ' ORDER BY sh.shipped_at)
                 FILTER (WHERE sh.finalized_at IS NOT NULL) AS boxes
        FROM shipment_items si
        JOIN shipments sh ON sh.id = si.shipment_id
        WHERE si.order_item_id = oi.id
          AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      ) att ON true
      WHERE o.id = {{params.order_id}}::bigint
        AND o.status NOT IN ('cancelled', 'refunded')
        AND o.external_id IS NOT NULL
        AND COALESCE(o.raw_import->>'source', '') NOT IN ('storefront', 'manual')
      ORDER BY p.sku_code
    `,
  });
}

export default getAdoptCandidateOrder;
