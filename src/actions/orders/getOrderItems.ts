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
      -- the label we bought for this direct line, if any — joined through
      -- transfers.direct_order_item_id (newest finalized wins) so the
      -- tracking shown here can never drift from the transfer log. Two
      -- gates: a refund-SUCCESS label provably never shipped (Shippo only
      -- refunds unused labels), and an UNFULFILLED line never shows
      -- tracking — a transfer that finalized with the stamp REFUSED
      -- (address/payment/qty drift; direct_stamped=0) still needs manual
      -- remediation, and presenting its label as live tracking on the
      -- outstanding line would hide exactly that
      LEFT JOIN LATERAL (
        SELECT t.carrier, t.tracking_number
        FROM transfers t
        WHERE t.direct_order_item_id = oi.id AND t.finalized_at IS NOT NULL
          AND oi.direct_fulfilled_at IS NOT NULL
          AND COALESCE(t.refund_status, '') <> 'SUCCESS'
        ORDER BY t.finalized_at DESC LIMIT 1
      ) dt ON true
      WHERE oi.order_id = {{params.order_id}}::bigint
      ORDER BY p.sku_code
    `,
  });
}

export default getOrderItems;
