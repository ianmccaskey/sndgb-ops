import { action } from '@uibakery/data';

/**
 * The shipping modal's per-line packing state for one order. remaining is
 * advisory for the UI — create_shipment_draft re-proves it row-locked, so
 * a stale modal can never over-attribute. Direct lines are included
 * (read-only in the modal) so the operator sees the whole order.
 *   effective  = COALESCE(qty_override, qty), 0 when removed
 *   attributed = SUM over non-voided shipments, drafts included
 *   shipped    = same over finalized rows only
 */
function getPackableItems() {
  return action('getPackableItems', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT oi.id AS order_item_id,
             p.id AS product_id, p.sku_code, p.name AS product_name,
             p.external_id AS product_external_id, p.unit_weight_oz, p.digital,
             oi.unit_price_usd,
             CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END AS effective_qty,
             COALESCE(att.attributed, 0) AS attributed_qty,
             COALESCE(att.shipped, 0) AS shipped_qty,
             GREATEST(CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END
                      - COALESCE(att.attributed, 0), 0) AS remaining_qty,
             oi.direct_ship, oi.direct_fulfilled_at, oi.removed_at
      FROM order_items oi
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(si.qty), 0) AS attributed,
               COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL), 0) AS shipped
        FROM shipment_items si
        JOIN shipments sh ON sh.id = si.shipment_id
        WHERE si.order_item_id = oi.id
          AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      ) att ON true
      WHERE oi.order_id = {{params.order_id}}::bigint
        AND oi.removed_at IS NULL
      ORDER BY p.sku_code
    `,
  });
}

export default getPackableItems;
