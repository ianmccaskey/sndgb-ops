import { action } from '@uibakery/data';

/**
 * Every package with its address label, vendor code, and item lines as
 * jsonb — the single feed for the dashboard, filters, and heads-up
 * banner. Received packages stay listed (they are the inventory story);
 * the UI separates them by received_at.
 */
function listInboundPackages() {
  return action('listInboundPackages', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      -- '#' guard: a 22-digit USPS number is re-typed to a ROUNDED JS
      -- number by the transport unless it travels with a non-digit char;
      -- the client strips the '#' at the row boundary (lib/rows dbText)
      SELECT p.id, p.receive_address_id, ra.label AS address_label, ra.active AS address_active,
             v.code AS vendor_code, p.carrier, '#' || p.tracking_number AS tracking_number, p.note,
             p.committed_at, p.tracking_status, p.tracking_substatus, p.tracking_detail,
             p.tracking_error, p.tracking_location, p.eta, p.status_date, p.last_checked_at,
             p.received_at, p.received_by, p.auto_receive_suppressed, p.created_by, p.created_at,
             COALESCE(items.items, '[]'::jsonb) AS items
      FROM inbound_packages p
      JOIN receive_addresses ra ON ra.id = p.receive_address_id
      LEFT JOIN vendors v ON v.id = p.vendor_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'id', i.id, 'product_id', i.product_id, 'sku_code', pr.sku_code, 'name', pr.name, 'qty', i.qty
               ) ORDER BY pr.sku_code) AS items
        FROM inbound_package_items i
        JOIN products pr ON pr.id = i.product_id
        WHERE i.package_id = p.id
      ) items ON true
      ORDER BY p.received_at NULLS FIRST, p.created_at DESC
    `,
  });
}

export default listInboundPackages;
