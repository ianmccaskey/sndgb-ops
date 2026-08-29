import { action } from '@uibakery/data';

function listOrders() {
  return action('listOrders', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id, o.order_number, o.status, o.payment_rail, o.hold_shipping,
             o.contact_name, o.contact_email, o.discord_username,
             o.city, o.state_code, o.total_usd, o.placed_at,
             c.display_name AS customer_name,
             r.recon_status, r.effective_received_usd, r.diff_usd, r.pending_payment_count,
             COALESCE(it.items_summary, '') AS items_summary,
             COALESCE(it.item_count, 0) AS item_count,
             -- derived over ALL non-voided shipments: 'partial' when some
             -- packable qty shipped and some remains; else max progression
             CASE
               WHEN COALESCE(s.ship_count, 0) = 0 THEN NULL
               WHEN COALESCE(s.shipped_packable_qty, 0) > 0
                    AND COALESCE(s.remaining_packable_qty, 0) > 0 THEN 'partial'
               ELSE CASE s.max_rank WHEN 5 THEN 'delivered' WHEN 4 THEN 'reshipped'
                                    WHEN 3 THEN 'shipped' WHEN 2 THEN 'packed' ELSE 'pending' END
             END AS shipment_status,
             COALESCE(s.tracking_numbers, '') AS tracking_number
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      LEFT JOIN (
        SELECT oi.order_id,
               string_agg(p.sku_code || ' (' || oi.qty || ')', '; ' ORDER BY p.sku_code) AS items_summary,
               SUM(oi.qty) AS item_count
        FROM order_items oi
        JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
        JOIN products p ON p.id = gbp.product_id
        GROUP BY oi.order_id
      ) it ON it.order_id = o.id
      LEFT JOIN LATERAL (
        SELECT count(*) AS ship_count,
               max(CASE sh.status WHEN 'delivered' THEN 5 WHEN 'reshipped' THEN 4
                                  WHEN 'shipped' THEN 3 WHEN 'packed' THEN 2 ELSE 1 END) AS max_rank,
               string_agg(sh.tracking_number, ', ' ORDER BY sh.created_at)
                 FILTER (WHERE sh.tracking_number IS NOT NULL) AS tracking_numbers,
               (SELECT COALESCE(sum(LEAST(a.shipped, a.eff)), 0)
                FROM (SELECT CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END AS eff,
                             (SELECT COALESCE(sum(si.qty), 0) FROM shipment_items si
                              JOIN shipments s2 ON s2.id = si.shipment_id
                              WHERE si.order_item_id = oi.id AND s2.finalized_at IS NOT NULL
                                AND COALESCE(s2.refund_status, '') <> 'SUCCESS') AS shipped
                      FROM order_items oi
                      JOIN group_buy_products g ON g.id = oi.group_buy_product_id
                      JOIN products p2 ON p2.id = g.product_id
                      WHERE oi.order_id = o.id AND NOT oi.direct_ship AND oi.removed_at IS NULL
                        AND NOT p2.digital) a) AS shipped_packable_qty,
               (SELECT COALESCE(sum(GREATEST(a.eff - a.attributed, 0)), 0)
                FROM (SELECT CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END AS eff,
                             (SELECT COALESCE(sum(si.qty), 0) FROM shipment_items si
                              JOIN shipments s2 ON s2.id = si.shipment_id
                              WHERE si.order_item_id = oi.id
                                AND COALESCE(s2.refund_status, '') <> 'SUCCESS') AS attributed
                      FROM order_items oi
                      JOIN group_buy_products g ON g.id = oi.group_buy_product_id
                      JOIN products p2 ON p2.id = g.product_id
                      WHERE oi.order_id = o.id AND NOT oi.direct_ship AND oi.removed_at IS NULL
                        AND NOT p2.digital) a) AS remaining_packable_qty
        FROM shipments sh
        WHERE sh.order_id = o.id AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      ) s ON true
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND ({{params.status}}::text = 'all' OR o.status::text = {{params.status}}::text)
        AND ({{params.rail}}::text = 'all' OR o.payment_rail::text = {{params.rail}}::text)
        AND ({{params.recon}}::text = 'all' OR COALESCE(r.recon_status, 'awaiting') = {{params.recon}}::text)
        AND (
          {{params.search}}::text = ''
          OR o.order_number ILIKE '%' || {{params.search}}::text || '%'
          OR c.display_name ILIKE '%' || {{params.search}}::text || '%'
          OR o.contact_email ILIKE '%' || {{params.search}}::text || '%'
          OR o.discord_username ILIKE '%' || {{params.search}}::text || '%'
        )
      ORDER BY o.placed_at DESC NULLS LAST, o.order_number DESC
      LIMIT 500
    `,
  });
}

export default listOrders;
