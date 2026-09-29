import { action } from '@uibakery/data';

/**
 * Stores the Shippo Order id created for a draft's upcoming label
 * purchase. Write-once (only fills NULL): a retry path must reuse the
 * order already created for this draft, not clobber it with a second
 * one — the stored id is what keeps retries from littering the Shippo
 * dashboard with duplicate orders. Best-effort caller contract: a
 * failed write only costs the retry-reuse, never the purchase.
 */
function setShipmentShippoOrder() {
  return action('setShipmentShippoOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE shipments
         SET shippo_order_id = {{params.shippo_order_id}}::text
       WHERE id = {{params.shipment_id}}::bigint
         AND shippo_order_id IS NULL
      RETURNING id
    `,
  });
}

export default setShipmentShippoOrder;
