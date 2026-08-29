import { action } from '@uibakery/data';

/**
 * Attach one package-contents photo (client-compressed JPEG data URL +
 * small thumbnail) to a shipment — draft or finalized (the box is
 * photographed before the label is bought, and the row may finalize
 * between capture and upload). Thin wrapper over add_shipment_photo
 * (migration 1786474800), which serializes per shipment on the parent
 * row lock and enforces every gate on a fresh post-lock snapshot:
 * shipment exists and not refund-voided, both payloads are image data
 * URLs within their size caps, and the POST-insert totals stay within
 * the quota (5 photos / 5MB aggregate per shipment — the incoming
 * photo counts). replay=true marks the AUTOMATIC retry path: a replay
 * whose exact image bytes were explicitly deleted from this shipment
 * (per the audit tombstones) refuses instead of resurrecting removed
 * evidence; a deliberate operator add passes replay=false and may
 * always re-attach. Refusals return zero rows. Audited with the byte
 * length, never the image.
 */
function addShipmentPhoto() {
  return action('addShipmentPhoto', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM add_shipment_photo(
        {{params.shipment_id}}::bigint,
        {{params.image_data}}::text,
        {{params.thumb_data}}::text,
        {{params.actor}}::text,
        {{params.replay}}::boolean
      )
    `,
  });
}

export default addShipmentPhoto;
