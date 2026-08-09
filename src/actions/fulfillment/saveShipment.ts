import { action } from '@uibakery/data';

function saveShipment() {
  return action('saveShipment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH existing AS (
        SELECT id FROM shipments
        WHERE order_id = {{params.order_id}}::bigint
        ORDER BY created_at DESC LIMIT 1
      ), upd AS (
        UPDATE shipments SET
          carrier = NULLIF({{params.carrier}}::text, ''),
          tracking_number = NULLIF({{params.tracking_number}}::text, ''),
          label_cost_usd = {{params.label_cost_usd}}::numeric,
          box = NULLIF({{params.box}}::text, ''),
          status = {{params.status}}::shipment_status,
          shipped_at = CASE WHEN {{params.status}} IN ('shipped','reshipped') AND shipped_at IS NULL THEN now() ELSE shipped_at END,
          note = NULLIF({{params.note}}::text, '')
        WHERE id IN (SELECT id FROM existing)
        RETURNING id
      ), ins AS (
        INSERT INTO shipments (order_id, carrier, tracking_number, label_cost_usd, box, status, shipped_at, note)
        SELECT {{params.order_id}}::bigint,
               NULLIF({{params.carrier}}::text, ''),
               NULLIF({{params.tracking_number}}::text, ''),
               {{params.label_cost_usd}}::numeric,
               NULLIF({{params.box}}::text, ''),
               {{params.status}}::shipment_status,
               CASE WHEN {{params.status}} IN ('shipped','reshipped') THEN now() ELSE NULL END,
               NULLIF({{params.note}}::text, '')
        WHERE NOT EXISTS (SELECT 1 FROM existing)
        RETURNING id
      )
      SELECT COALESCE((SELECT id FROM upd), (SELECT id FROM ins)) AS id
    `,
  });
}

export default saveShipment;
