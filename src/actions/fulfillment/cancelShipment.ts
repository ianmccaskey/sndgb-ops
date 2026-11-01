import { action } from '@uibakery/data';

/**
 * Cancel a FINALIZED shipment that was recorded shipped by mistake —
 * at once, without waiting for the label refund (migration 1790103200).
 * Thin wrapper over cancel_finalized_shipment(), which takes the 42001
 * order lock, refuses a draft, a refund-voided, an already-cancelled or
 * an adopted ('upstream') box, removes every recorded line (the units
 * return to remaining-to-pack and the ship-from inventory; the order
 * re-enters Ready to pack), keeps what the box held on the row and in the
 * 'shipment_cancelled' audit row, and bumps push_epoch so a push of this
 * box in flight cannot stamp it. The label refund is separate and
 * untouched. Refusals return zero rows. The ordering app is reset by the
 * caller (resetVoidedShipmentUpstream).
 */
function cancelShipment() {
  return action('cancelShipment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o_shipment_id AS shipment_id, o_order_id AS order_id,
             o_items AS items, o_was_pushed AS was_pushed
      FROM cancel_finalized_shipment(
        {{params.shipment_id}}::bigint,
        NULLIF(btrim({{params.reason}}::text), ''),
        NULLIF(btrim({{params.actor}}::text), '')
      )
    `,
  });
}

export default cancelShipment;
