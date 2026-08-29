import { action } from '@uibakery/data';

/** One photo's FULL image, loaded on demand when the operator enlarges a
 * thumbnail — list views carry only thumb_data. */
function getShipmentPhoto() {
  return action('getShipmentPhoto', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT sp.id, sp.image_data
      FROM shipment_photos sp
      WHERE sp.id = {{params.photo_id}}::bigint
    `,
  });
}

export default getShipmentPhoto;
