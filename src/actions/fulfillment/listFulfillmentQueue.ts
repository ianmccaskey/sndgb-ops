import { action } from '@uibakery/data';

/** Orders eligible to pack/ship: reconciled (or verified) and not held. */
function listFulfillmentQueue() {
  return action('listFulfillmentQueue', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id, o.order_number, c.display_name AS customer_name,
             o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code,
             o.hold_shipping, o.customer_note, o.admin_note,
             r.recon_status,
             -- items WE pack; vendor-direct lines live in direct_items_summary
             COALESCE(it.items_summary, '') AS items_summary,
             COALESCE(it.item_count, 0) AS item_count,
             COALESCE(it.direct_items_summary, '') AS direct_items_summary,
             COALESCE(it.direct_outstanding_summary, '') AS direct_outstanding_summary,
             COALESCE(it.direct_outstanding_ids, '') AS direct_outstanding_ids,
             COALESCE(it.all_direct, false) AS all_direct,
             COALESCE(it.direct_outstanding, false) AS direct_outstanding,
             s.id AS shipment_id, s.status AS shipment_status, s.carrier, s.tracking_number,
             s.label_cost_usd, s.box
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      LEFT JOIN (
        SELECT oi.order_id,
               string_agg(p.sku_code || ' (' || oi.qty || ')', '; ' ORDER BY p.sku_code)
                 FILTER (WHERE NOT oi.direct_ship) AS items_summary,
               COALESCE(SUM(oi.qty) FILTER (WHERE NOT oi.direct_ship), 0) AS item_count,
               string_agg(p.sku_code || ' (' || oi.qty || ')', '; ' ORDER BY p.sku_code)
                 FILTER (WHERE oi.direct_ship) AS direct_items_summary,
               -- what the vendor STILL owes — the direct tab's row text and
               -- the bulk button's confirm show this, so the confirmation
               -- lists exactly the lines the bulk action will stamp
               string_agg(p.sku_code || ' (' || oi.qty || ')', '; ' ORDER BY p.sku_code)
                 FILTER (WHERE oi.direct_ship AND oi.direct_fulfilled_at IS NULL) AS direct_outstanding_summary,
               -- the ids behind that summary — the bulk button passes them
               -- back so the stamp is anchored to exactly what was confirmed
               string_agg(oi.id::text, ',' ORDER BY oi.id)
                 FILTER (WHERE oi.direct_ship AND oi.direct_fulfilled_at IS NULL) AS direct_outstanding_ids,
               bool_and(oi.direct_ship) AS all_direct,
               bool_or(oi.direct_ship AND oi.direct_fulfilled_at IS NULL) AS direct_outstanding
        FROM order_items oi
        JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
        JOIN products p ON p.id = gbp.product_id
        GROUP BY oi.order_id
      ) it ON it.order_id = o.id
      LEFT JOIN LATERAL (
        SELECT * FROM shipments sh WHERE sh.order_id = o.id ORDER BY sh.created_at DESC LIMIT 1
      ) s ON true
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND o.status NOT IN ('cancelled','refunded')
        AND ({{params.stage}} = 'all'
          -- ready requires matched AND no unresolved payments: an order can
          -- read matched (e.g. via write-off/comp) while a new hash pends —
          -- money evidence must be resolved before shipping. Fully-direct
          -- orders leave the pack list — they are the 'direct' stage.
          OR ({{params.stage}} = 'ready' AND COALESCE(s.status::text,'pending') = 'pending' AND NOT o.hold_shipping AND r.recon_status = 'matched' AND r.pending_payment_count = 0
              AND NOT COALESCE(it.all_direct, false))
          -- same money gates as ready, but for VENDOR-shipped lines: any order
          -- (fully direct or mixed) with a direct line the vendor hasn't
          -- shipped yet. Deliberately NOT gated on the local shipment row —
          -- a mixed order's local half packing/shipping must not hide its
          -- outstanding vendor half. Rows leave via "Mark vendor shipped".
          OR ({{params.stage}} = 'direct' AND NOT o.hold_shipping AND r.recon_status = 'matched' AND r.pending_payment_count = 0
              AND COALESCE(it.direct_outstanding, false))
          OR ({{params.stage}} = 'held' AND o.hold_shipping)
          OR ({{params.stage}} = 'packed' AND s.status = 'packed')
          OR ({{params.stage}} = 'shipped' AND s.status IN ('shipped','delivered','reshipped')))
      ORDER BY o.order_number
      LIMIT 1000
    `,
  });
}

export default listFulfillmentQueue;
