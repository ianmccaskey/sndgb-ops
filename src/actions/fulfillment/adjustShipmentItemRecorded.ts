import { action } from '@uibakery/data';

/**
 * Correct ONE recorded line of a FINALIZED shipment (the "items were
 * recorded shipped that weren't" fix — MB5-303 class, previously manual
 * DB surgery). Thin wrapper over adjust_shipment_item_recorded
 * (migration 1790000000), which locks 42001(order) -> shipment FOR
 * UPDATE -> order_items FOR UPDATE and re-proves every gate post-lock:
 * finalized non-voided shipments only; increases capped by the SAME
 * remaining formula getPackableItems displays (effective minus all
 * non-voided attribution incl. drafts); no additions to removed/digital
 * lines; reason required; new qty 0 deletes the line, an absent line
 * inserts. Clears b44_pushed_at so the corrected contents re-offer
 * "Push upstream" — the push never DOWNGRADES an upstream
 * shipped/terminal status, so the UI says to fix upstream by hand when
 * a correction un-completes an order. Refusals return zero rows.
 * Audited with old/new qty + reason.
 */
function adjustShipmentItemRecorded() {
  return action('adjustShipmentItemRecorded', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o_shipment_id AS shipment_id, o_order_item_id AS order_item_id,
             o_old_qty AS old_qty, o_new_qty AS new_qty,
             o_sku_code AS sku_code, o_items_left AS items_left
      FROM adjust_shipment_item_recorded(
        {{params.shipment_id}}::bigint,
        {{params.order_item_id}}::bigint,
        NULLIF({{params.new_qty}}::text, '')::numeric,
        {{params.reason}}::text,
        {{params.actor}}::text
      )
    `,
  });
}

export default adjustShipmentItemRecorded;
