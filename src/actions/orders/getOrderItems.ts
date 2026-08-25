import { action } from '@uibakery/data';

function getOrderItems() {
  return action('getOrderItems', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT oi.id, oi.qty, oi.unit_price_usd, (oi.qty * oi.unit_price_usd) AS line_total_usd,
             oi.comp_qty, oi.comp_reason,
             (LEAST(oi.comp_qty, CASE WHEN oi.removed_at IS NULL THEN COALESCE(oi.qty_override, oi.qty) ELSE 0 END) * oi.unit_price_usd) AS comp_value_usd,
             oi.direct_ship, oi.direct_ship_source, oi.direct_fulfilled_at, oi.item_source,
             oi.qty_override, oi.removed_at, oi.split_fee_usd,
             p.sku_code, p.name AS product_name, p.mass_label, p.external_id AS product_external_id,
             dt.carrier AS direct_carrier, dt.tracking_number AS direct_tracking_number
      FROM order_items oi
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      -- the label that OWNS this line's current fulfillment — joined
      -- through order_items.direct_fulfilled_transfer_id, which only the
      -- successful stamp sets and the manual undo/mark clears. A
      -- stamp-refused finalize, a stamped-then-undone transfer, and a
      -- manual re-fulfill all leave the pointer NULL, so none of their
      -- labels can masquerade as the line's shipment. Refund-SUCCESS
      -- (label provably never used) hides the tracking too.
      LEFT JOIN transfers dt
        ON dt.id = oi.direct_fulfilled_transfer_id
       AND COALESCE(dt.refund_status, '') <> 'SUCCESS'
      WHERE oi.order_id = {{params.order_id}}::bigint
      ORDER BY p.sku_code
    `,
  });
}

export default getOrderItems;
