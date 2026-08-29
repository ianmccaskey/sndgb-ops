import { action } from '@uibakery/data';

/**
 * Delete an UNFINALIZED shipment draft (failed/abandoned purchase),
 * freeing its attributed quantities (CASCADE removes shipment_items — the
 * order's remaining-to-pack grows back). Thin wrapper over
 * delete_shipment_draft (migration 1786475000), which locks
 * 42001(order) -> shipments row FOR UPDATE and re-proves every gate on a
 * fresh post-lock snapshot: a finalized shipment never deletes here (the
 * refund flow voids it instead); a purchase lease fresher than 10
 * minutes refuses (a label purchase may be in flight — this session's or
 * the other admin's); a dispatched Shippo POST (purchase_attempted_at)
 * refuses until a proof-of-absence walk stamped
 * attempt_verified_no_label_at. Items snapshot into old_data, and every
 * cascading package photo leaves a TOMBSTONE audit row (reason
 * draft_deleted, with md5 fingerprint + full thumbnail blob + creator) —
 * the post-lock snapshot means even a photo attached concurrently with
 * the delete gets its tombstone. Refusals return zero rows. Audited.
 */
function deleteShipmentDraft() {
  return action('deleteShipmentDraft', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM delete_shipment_draft(
        {{params.shipment_id}}::bigint,
        {{params.actor}}::text
      )
    `,
  });
}

export default deleteShipmentDraft;
