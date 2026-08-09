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
             s.status AS shipment_status, s.tracking_number
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
        SELECT status, tracking_number FROM shipments sh
        WHERE sh.order_id = o.id ORDER BY sh.created_at DESC LIMIT 1
      ) s ON true
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND ({{params.status}} = 'all' OR o.status::text = {{params.status}})
        AND ({{params.rail}} = 'all' OR o.payment_rail::text = {{params.rail}})
        AND ({{params.recon}} = 'all' OR COALESCE(r.recon_status, 'awaiting') = {{params.recon}})
        AND (
          {{params.search}} = ''
          OR o.order_number ILIKE '%' || {{params.search}} || '%'
          OR c.display_name ILIKE '%' || {{params.search}} || '%'
          OR o.contact_email ILIKE '%' || {{params.search}} || '%'
          OR o.discord_username ILIKE '%' || {{params.search}} || '%'
        )
      ORDER BY o.placed_at DESC NULLS LAST, o.order_number DESC
      LIMIT 500
    `,
  });
}

export default listOrders;
