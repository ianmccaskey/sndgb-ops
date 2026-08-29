import { action } from '@uibakery/data';

/**
 * Attach one package-contents photo (client-compressed JPEG data URL +
 * small thumbnail) to a shipment — draft or finalized (the box is
 * photographed before the label is bought, and the row may finalize
 * between capture and upload). Guards: the shipment must exist and not be
 * refund-voided; both payloads must be image data URLs within their size
 * caps (the table CHECKs backstop); and a per-shipment QUOTA (5 photos /
 * ~5MB aggregate) refuses a mistaken bulk select before it can bloat the
 * shipment's views. Audited with the byte length, never the image.
 */
function addShipmentPhoto() {
  return action('addShipmentPhoto', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO shipment_photos (shipment_id, image_data, thumb_data, created_by)
        SELECT s.id, {{params.image_data}}::text, {{params.thumb_data}}::text, {{params.actor}}::text
        FROM shipments s
        WHERE s.id = {{params.shipment_id}}::bigint
          AND COALESCE(s.refund_status, '') <> 'SUCCESS'
          AND {{params.image_data}}::text LIKE 'data:image/%'
          AND length({{params.image_data}}::text) BETWEEN 100 AND 1500000
          AND {{params.thumb_data}}::text LIKE 'data:image/%'
          AND length({{params.thumb_data}}::text) BETWEEN 100 AND 80000
          AND (SELECT count(*) FROM shipment_photos sp WHERE sp.shipment_id = s.id) < 5
          AND COALESCE((SELECT sum(length(sp.image_data)) FROM shipment_photos sp WHERE sp.shipment_id = s.id), 0) < 5000000
        RETURNING id, shipment_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipment_photos', ins.id::text, 'shipment_photo_added', {{params.actor}}::text,
             jsonb_build_object('shipment_id', ins.shipment_id,
                                'bytes', length({{params.image_data}}::text))
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addShipmentPhoto;
