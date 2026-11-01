import { action } from '@uibakery/data';

/**
 * The auto-adopt pass's write (src/lib/autoAdopt.ts): the Adopt button's
 * adopt_upstream_shipment() behind adopt_upstream_shipment_untouched()
 * (migration 1790103100), which first proves — under the order lock —
 * that every named line still has ZERO attribution here (no box, no
 * draft, no adopted row). A hand mark in the ordering app is therefore
 * recorded at most once, whatever runs or clicks race it. Zero rows =
 * refused; the operator's Adopt button keeps the plain fn.
 */
function adoptUpstreamShipmentUntouched() {
  return action('adoptUpstreamShipmentUntouched', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM adopt_upstream_shipment_untouched(
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

export default adoptUpstreamShipmentUntouched;
