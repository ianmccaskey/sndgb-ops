import { action } from '@uibakery/data';

/** Per-address on-hand inventory (received − transferred, negatives visible). */
function listAddressInventory() {
  return action('listAddressInventory', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT inv.receive_address_id, ra.label AS address_label,
             inv.product_id, pr.sku_code, pr.name AS product_name,
             inv.received_qty, inv.transferred_qty, inv.on_hand_qty
      FROM v_address_inventory inv
      JOIN receive_addresses ra ON ra.id = inv.receive_address_id
      JOIN products pr ON pr.id = inv.product_id
      ORDER BY ra.label, pr.sku_code
    `,
  });
}

export default listAddressInventory;
