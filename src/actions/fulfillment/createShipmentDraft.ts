import { action } from '@uibakery/data';

/**
 * Create an order-shipment DRAFT — BEFORE the label is purchased, so a
 * failed or interrupted purchase never leaves a paid label with no record.
 * All the real logic lives in create_shipment_draft() (migrations
 * 1786473500/1786473700): per-order 42001 advisory-lock serialization,
 * row-locked order + money gates, ship-to and ship-from content-CAS with
 * server-side snapshots, per-line attribution validation against
 * remaining-to-pack (drafts reserve), the birth purchase lease, and the
 * audit row. Returns (id, claimed_at); ZERO ROWS = refused.
 */
function createShipmentDraft() {
  return action('createShipmentDraft', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, claimed_at FROM create_shipment_draft(
        {{params.order_id}}::bigint,
        {{params.group_buy_id}}::bigint,
        {{params.ship_from_address_id}}::bigint,
        {{params.expected_from}}::jsonb,
        {{params.expected_to}}::jsonb,
        {{params.parcel}}::jsonb,
        {{params.carrier}}::text,
        {{params.servicelevel}}::text,
        {{params.rate_amount}}::text,
        {{params.rate_currency}}::text,
        {{params.shippo_rate_id}}::text,
        {{params.items}}::jsonb,
        {{params.box}}::text,
        {{params.note}}::text,
        {{params.actor}}::text
      )
    `,
  });
}

export default createShipmentDraft;
