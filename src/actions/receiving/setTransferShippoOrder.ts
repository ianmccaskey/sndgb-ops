import { action } from '@uibakery/data';

/**
 * Stores the Shippo Order id created for a direct-ship transfer draft's
 * upcoming label purchase. Same write-once contract as
 * setShipmentShippoOrder.
 */
function setTransferShippoOrder() {
  return action('setTransferShippoOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE transfers
         SET shippo_order_id = {{params.shippo_order_id}}::text
       WHERE id = {{params.transfer_id}}::bigint
         AND shippo_order_id IS NULL
      RETURNING id
    `,
  });
}

export default setTransferShippoOrder;
