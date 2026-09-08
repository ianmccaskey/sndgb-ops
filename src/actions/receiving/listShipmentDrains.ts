import { action } from '@uibakery/data';

/**
 * Per-product quantities that finalized, non-refunded order shipments took
 * OUT of each ship-from address group — across ALL campaigns, because the
 * drain is physical. Feeds the client-side boxConsumption() so the
 * Receiving dashboard's box display depletes as orders are packed (FIFO
 * across the group's received boxes), matching what v_address_inventory
 * now subtracts at the unit level (migration 1786477500).
 */
function listShipmentDrains() {
  return action('listShipmentDrains', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT s.ship_from_address_id AS receive_address_id, gbp.product_id, SUM(si.qty) AS qty
      FROM shipment_items si
      JOIN shipments s ON s.id = si.shipment_id
      JOIN order_items oi ON oi.id = si.order_item_id
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      WHERE s.finalized_at IS NOT NULL AND COALESCE(s.refund_status, '') <> 'SUCCESS'
        AND s.ship_from_address_id IS NOT NULL
      GROUP BY s.ship_from_address_id, gbp.product_id
    `,
  });
}

export default listShipmentDrains;
