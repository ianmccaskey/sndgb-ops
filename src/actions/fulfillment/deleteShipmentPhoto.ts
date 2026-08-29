import { action } from '@uibakery/data';

/**
 * Remove a package photo (retake of a blurry shot, wrong box). Allowed in
 * any shipment state — the two-admin trust model applies — but audited
 * with the photo's size and age, so a photo that existed leaves a trail
 * even after removal.
 */
function deleteShipmentPhoto() {
  return action('deleteShipmentPhoto', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH del AS (
        DELETE FROM shipment_photos sp
        WHERE sp.id = {{params.photo_id}}::bigint
        RETURNING sp.id, sp.shipment_id, length(sp.image_data) AS bytes, sp.created_at
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
      SELECT 'shipment_photos', del.id::text, 'shipment_photo_deleted', {{params.actor}}::text,
             jsonb_build_object('shipment_id', del.shipment_id, 'bytes', del.bytes,
                                'taken_at', del.created_at)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteShipmentPhoto;
