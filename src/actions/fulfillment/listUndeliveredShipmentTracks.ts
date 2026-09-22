import { action } from '@uibakery/data';

/**
 * The refresh worklist for the Shipped tab's delivery check: finalized,
 * non-voided order shipments of the SELECTED campaign whose carrier has
 * not yet said DELIVERED (or RETURNED — terminal too). Skipping the
 * already-delivered rows is what keeps the loop cheap after the first
 * full pass: a delivered box never gets polled again. '#'-guard on the
 * tracking number (transport re-types digit-only text as rounded JS
 * numbers). LIMIT bounds one run; the button says when another run is
 * needed.
 */
function listUndeliveredShipmentTracks() {
  return action('listUndeliveredShipmentTracks', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT s.id, s.carrier, '#' || s.tracking_number AS tracking_number
      FROM shipments s
      JOIN orders o ON o.id = s.order_id
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND s.finalized_at IS NOT NULL
        AND COALESCE(s.refund_status, '') <> 'SUCCESS'
        AND COALESCE(s.tracking_number, '') <> ''
        AND COALESCE(s.carrier, '') <> ''
        AND COALESCE(s.tracking_status, '') NOT IN ('DELIVERED', 'RETURNED')
      ORDER BY s.finalized_at
      LIMIT 200
    `,
  });
}

export default listUndeliveredShipmentTracks;
