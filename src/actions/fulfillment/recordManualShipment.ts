import { action } from '@uibakery/data';

/**
 * Record a shipment whose label was bought OUTSIDE the app — born
 * FINALIZED (status shipped) via create_manual_shipment() (migrations
 * 1786473600/1786473700): same order/money/ship-to gates and attribution
 * validation as the draft path, canonical compact tracking, and a 120-day
 * cross-path duplicate refusal (vs finalized shipments AND transfers)
 * race-protected by a tracking-fingerprint advisory lock. Nothing was
 * charged through us, so any refusal (zero rows) is harmless. Replaces
 * the old un-audited saveShipment as the manual entry path.
 * ship_from_address_id may be '' (unknown provenance — no address CAS).
 */
function recordManualShipment() {
  return action('recordManualShipment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM create_manual_shipment(
        {{params.order_id}}::bigint,
        {{params.group_buy_id}}::bigint,
        NULLIF({{params.ship_from_address_id}}::text, '')::bigint,
        {{params.expected_from}}::jsonb,
        {{params.expected_to}}::jsonb,
        {{params.carrier}}::text,
        {{params.tracking_number}}::text,
        {{params.cost}}::text,
        {{params.items}}::jsonb,
        {{params.box}}::text,
        {{params.note}}::text,
        {{params.actor}}::text
      )
    `,
  });
}

export default recordManualShipment;
