import { action } from '@uibakery/data';

/**
 * Active local orders that came from the ordering app (have an external_id),
 * for one campaign. The Import page diffs this list against a freshly pulled
 * set to spot orders DELETED upstream — those simply stop appearing in pulls
 * (unlike cancellations, which arrive as a status), so without this diff they
 * linger locally in demand/revenue forever.
 *
 * Source-bound: only rows whose preserved raw_import PROVES they came from
 * the base44 campaign currently linked (gb_external_id) are returned. If the
 * local campaign is ever relinked to a different base44 campaign, orders from
 * the old source fail this filter and are never offered for cancellation —
 * absence from the new source's pull is not evidence of deletion. Pasted
 * legacy rows (no base44 raw_import) are excluded for the same reason.
 */
function listActiveExternalOrders() {
  return action('listActiveExternalOrders', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id, o.order_number, o.external_id, o.contact_name, o.total_usd
      FROM orders o
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND o.status NOT IN ('cancelled','refunded')
        AND o.external_id IS NOT NULL AND o.external_id <> ''
        AND o.raw_import->>'source' = 'base44'
        AND (o.raw_import->>'json')::jsonb->>'group_buy_id' = {{params.gb_external_id}}::text
      ORDER BY o.order_number
    `,
  });
}

export default listActiveExternalOrders;
