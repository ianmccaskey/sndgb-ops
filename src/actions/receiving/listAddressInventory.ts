import { action } from '@uibakery/data';

/**
 * On-hand inventory aggregated by TRANSFER-ORIGIN GROUP (received −
 * transferred). Grouped addresses pool their stock at the origin —
 * receives land at member addresses while transfers subtract from the
 * origin, so the per-address ledger reads nonsense for grouped
 * locations (e.g. the origin at −80 while members hold +80). Rows key
 * on the ORIGIN's id + label; ungrouped addresses are themselves.
 * Negatives stay visible. v_address_inventory itself remains the
 * per-address truth (the transfer fns aggregate it the same way).
 */
function listAddressInventory() {
  return action('listAddressInventory', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT org.id AS receive_address_id, org.label AS address_label,
             inv.product_id, pr.sku_code, pr.name AS product_name,
             SUM(inv.received_qty) AS received_qty,
             SUM(inv.transferred_qty) AS transferred_qty,
             SUM(inv.on_hand_qty) AS on_hand_qty
      FROM v_address_inventory inv
      JOIN receive_addresses ra ON ra.id = inv.receive_address_id
      JOIN receive_addresses org ON org.id = COALESCE(ra.transfer_origin_id, ra.id)
      JOIN products pr ON pr.id = inv.product_id
      GROUP BY org.id, org.label, inv.product_id, pr.sku_code, pr.name
      ORDER BY org.label, pr.sku_code
    `,
  });
}

export default listAddressInventory;
