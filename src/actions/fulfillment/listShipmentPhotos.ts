import { action } from '@uibakery/data';

/** All package photos for one order's shipments (full image data — the
 * payload is bounded by the per-photo size cap and per-order volume). */
function listShipmentPhotos() {
  return action('listShipmentPhotos', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT sp.id, sp.shipment_id, sp.image_data, sp.created_by, sp.created_at
      FROM shipment_photos sp
      JOIN shipments s ON s.id = sp.shipment_id
      WHERE s.order_id = {{params.order_id}}::bigint
      ORDER BY sp.created_at
    `,
  });
}

export default listShipmentPhotos;
