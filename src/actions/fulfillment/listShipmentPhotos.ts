import { action } from '@uibakery/data';

/** THUMBNAILS ONLY for one order's shipments — the full image loads on
 * demand via getShipmentPhoto when the operator enlarges one, so list
 * views never carry multi-megabyte payloads. */
function listShipmentPhotos() {
  return action('listShipmentPhotos', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT sp.id, sp.shipment_id, sp.thumb_data, sp.created_by, sp.created_at
      FROM shipment_photos sp
      JOIN shipments s ON s.id = sp.shipment_id
      WHERE s.order_id = {{params.order_id}}::bigint
      ORDER BY sp.created_at
    `,
  });
}

export default listShipmentPhotos;
