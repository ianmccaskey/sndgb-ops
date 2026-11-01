import { action } from '@uibakery/data';

/**
 * Every line of every active ORDERING-APP order in a campaign, with what
 * this app has recorded against it — the auto-adopt pass's local side
 * (src/lib/autoAdopt.ts). One read per run; the pass joins it to the
 * ordering app's per-item shipped facts by product_external_id.
 *
 * Only orders the ordering app owns qualify: an upstream id, and neither
 * the storefront's nor a manual order's source marker. Removed lines are
 * out (nothing to adopt, nothing to push). Quantities:
 *   effective  = COALESCE(qty_override, qty)
 *   attributed = every non-voided shipment, drafts included (what a new
 *                adoption may not exceed — adopt_upstream_shipment
 *                re-proves this row-locked)
 *   shipped    = finalized rows only
 *   adopted    = finalized rows born from the ordering app (carrier
 *                'upstream') — already pulled down
 *   local_box  = finalized rows shipped from HERE (a real or manual box)
 *   last_shipped_on = the latest finalized box date, for the write-back
 * Vendor-direct lines carry their stamp and the vendor's label.
 */
function listAdoptCandidates() {
  return action('listAdoptCandidates', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT o.id AS order_id, o.order_number, o.external_id,
             oi.id AS order_item_id,
             cpl.external_id AS product_external_id,
             p.sku_code, p.digital,
             oi.direct_ship, oi.direct_fulfilled_at,
             oi.direct_vendor_carrier, oi.direct_vendor_tracking,
             COALESCE(oi.qty_override, oi.qty) AS effective_qty,
             COALESCE(att.attributed, 0) AS attributed_qty,
             COALESCE(att.shipped, 0) AS shipped_qty,
             COALESCE(att.adopted, 0) AS adopted_qty,
             COALESCE(att.local_box, 0) AS local_box_qty,
             att.last_shipped_on,
             att.boxes
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id AND oi.removed_at IS NULL
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      -- the ordering-app product id in THIS campaign (1790101900)
      LEFT JOIN campaign_product_links cpl
        ON cpl.group_buy_id = gbp.group_buy_id AND cpl.product_id = p.id
      LEFT JOIN LATERAL (
        SELECT COALESCE(sum(si.qty), 0) AS attributed,
               COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL), 0) AS shipped,
               COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL AND sh.carrier = 'upstream'), 0) AS adopted,
               COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL AND sh.carrier <> 'upstream'), 0) AS local_box,
               (max(sh.shipped_at) FILTER (WHERE sh.finalized_at IS NOT NULL AND sh.carrier <> 'upstream'))::date::text AS last_shipped_on,
               string_agg(sh.shipped_at::date::text || ' ' || sh.carrier || ' ' || COALESCE(NULLIF(sh.tracking_number, ''), '(no tracking)'), '; ' ORDER BY sh.shipped_at)
                 FILTER (WHERE sh.finalized_at IS NOT NULL) AS boxes
        FROM shipment_items si
        JOIN shipments sh ON sh.id = si.shipment_id
        WHERE si.order_item_id = oi.id
          AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      ) att ON true
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND o.status NOT IN ('cancelled', 'refunded')
        AND o.external_id IS NOT NULL
        AND COALESCE(o.raw_import->>'source', '') NOT IN ('storefront', 'manual')
      ORDER BY o.order_number, p.sku_code
    `,
  });
}

export default listAdoptCandidates;
