import { action } from '@uibakery/data';

/** One photo's FULL image, loaded on demand when the operator enlarges a
 * thumbnail — list views carry only thumb_data. shipment_id is an
 * integrity guard (same convention as deleteShipmentPhoto): the read
 * refuses unless the photo belongs to the shipment on screen, so stale
 * client state cannot surface another shipment's evidence. */
function getShipmentPhoto() {
  return action('getShipmentPhoto', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT sp.id, sp.image_data
      FROM shipment_photos sp
      WHERE sp.id = {{params.photo_id}}::bigint
        AND sp.shipment_id = {{params.shipment_id}}::bigint
    `,
  });
}

export default getShipmentPhoto;
