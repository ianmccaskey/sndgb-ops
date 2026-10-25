import { action } from '@uibakery/data';

/**
 * Orders whose verified crypto money sits on ONE network that is not the
 * order's rail — the auto-reconcile pass's rail step reads this after the
 * payment steps. Same evidence rule as updateOrderRail re-proves at write
 * time (every verified tx-hash payment on exactly one network). Cancelled
 * and refunded orders are out; `source` tells the caller who owns the rail
 * (a storefront order follows its claims on every pull, so the pass
 * reports it instead of writing).
 */
function listRailCandidates() {
  return action('listRailCandidates', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id AS order_id, o.order_number, o.external_id,
             o.payment_rail::text AS payment_rail,
             o.raw_import->>'source' AS source,
             v.method AS verified_method
      FROM orders o
      JOIN LATERAL (
        SELECT MIN(p.method::text) AS method, COUNT(DISTINCT p.method) AS n
        FROM payments p
        WHERE p.order_id = o.id
          AND p.status = 'verified' AND p.tx_hash IS NOT NULL AND p.tx_hash <> ''
      ) v ON v.n = 1
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND o.status NOT IN ('cancelled','refunded')
        AND o.payment_rail IN ('eth','sol','base')
        AND v.method <> o.payment_rail::text
      ORDER BY o.order_number
      LIMIT 200
    `,
  });
}

export default listRailCandidates;
