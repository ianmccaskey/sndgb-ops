import { action } from '@uibakery/data';

/**
 * Record a shipment that ALREADY HAPPENED per the ordering app (per-item
 * shipped_date / order-level 'shipped') via adopt_upstream_shipment()
 * (migration 1786476400): born finalized, carrier 'upstream', NO
 * tracking, b44_pushed_at pre-stamped (upstream is the source — nothing
 * to push back). Money/hold gates are deliberately absent — this records
 * physical history; the attribution validation (qty <= remaining, row
 * locked) still refuses double-adoption. Zero rows = refused.
 */
function adoptUpstreamShipment() {
  return action('adoptUpstreamShipment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM adopt_upstream_shipment(
        {{params.order_id}}::bigint,
        {{params.group_buy_id}}::bigint,
        {{params.items}}::jsonb,
        {{params.shipped_date}}::text,
        {{params.note}}::text,
        {{params.actor}}::text
      )
    `,
  });
}

export default adoptUpstreamShipment;
