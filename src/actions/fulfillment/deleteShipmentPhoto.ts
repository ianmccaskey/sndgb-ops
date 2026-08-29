import { action } from '@uibakery/data';

/**
 * Remove a package photo (retake of a blurry shot, wrong box). Thin
 * wrapper over delete_shipment_photo (migration 1786475500) — deletion
 * lives in the database so the tombstone it writes can never skew from
 * the replay guard that consumes it. Allowed in any shipment state —
 * the two-admin trust model applies — but the audit row is a TOMBSTONE,
 * not just metadata: the SHA-256 fingerprint of the full image (provable
 * identity of what was removed), the complete thumbnail blob
 * (human-viewable record), creator, size, and age. Removing a photo can
 * never erase evidence unprovably — only reclaim the full-resolution
 * bytes. shipment_id is an integrity guard: the delete refuses unless
 * the photo belongs to the shipment the operator is looking at, so
 * stale client state cannot remove evidence from a different box.
 * Refusals return zero rows.
 */
function deleteShipmentPhoto() {
  return action('deleteShipmentPhoto', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM delete_shipment_photo(
        {{params.photo_id}}::bigint,
        {{params.shipment_id}}::bigint,
        {{params.actor}}::text
      )
    `,
  });
}

export default deleteShipmentPhoto;
