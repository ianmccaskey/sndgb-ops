import { action } from '@uibakery/data';

/**
 * Orders eligible to pack/ship: reconciled (or verified) and not held.
 *
 * Multi-shipment model: an order can have MANY shipments (partial boxes,
 * one tracking each). Everything here derives from AGGREGATES over the
 * order's non-voided shipments (refund_status <> 'SUCCESS') — never a
 * "latest row". Per-line packing math:
 *   effective  = COALESCE(qty_override, qty), removed lines excluded
 *   attributed = SUM(shipment_items.qty) over non-voided shipments,
 *                drafts INCLUDED (a draft reserves its quantities)
 *   shipped    = same sum over FINALIZED rows only
 *   remaining  = GREATEST(effective - attributed, 0)
 * 'ready' = money-gated orders with remaining packable work — a partially
 * shipped order stays here (badged) until its last box is drafted.
 *
 * Product filters: product_ids is a CSV of product ids ('' = off);
 * filter_mode 'contains' = order has at least one active packable line in
 * the set (other items allowed); 'only' = additionally NO active packable
 * line outside the set. Both deliberately consider PACKABLE lines only —
 * vendor-direct lines are not in your box and never disqualify an order.
 */
function listFulfillmentQueue() {
  return action('listFulfillmentQueue', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH sel AS (
        SELECT unnest(string_to_array(NULLIF({{params.product_ids}}::text, ''), ','))::bigint AS pid
      )
      SELECT o.id, o.order_number, o.external_id, c.display_name AS customer_name,
             o.contact_name, o.contact_email::text AS contact_email, o.contact_phone,
             o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code,
             o.hold_shipping, o.customer_note, o.admin_note,
             r.recon_status,
             -- items WE pack; vendor-direct lines live in direct_items_summary
             COALESCE(it.items_summary, '') AS items_summary,
             COALESCE(it.item_count, 0) AS item_count,
             COALESCE(it.remaining_summary, '') AS remaining_summary,
             COALESCE(it.remaining_packable_qty, 0) AS remaining_packable_qty,
             COALESCE(it.shipped_packable_qty, 0) AS shipped_packable_qty,
             COALESCE(it.packable_json, '[]'::jsonb) AS packable_json,
             COALESCE(it.direct_items_summary, '') AS direct_items_summary,
             COALESCE(it.direct_outstanding_summary, '') AS direct_outstanding_summary,
             COALESCE(it.direct_outstanding_ids, '') AS direct_outstanding_ids,
             COALESCE(it.all_direct, false) AS all_direct,
             COALESCE(it.direct_outstanding, false) AS direct_outstanding,
             -- derived order-level shipment state (NULL = nothing active)
             CASE
               WHEN COALESCE(s.ship_count, 0) = 0 THEN NULL
               WHEN COALESCE(it.shipped_packable_qty, 0) > 0
                    AND COALESCE(it.remaining_packable_qty, 0) > 0 THEN 'partial'
               ELSE CASE s.max_rank WHEN 5 THEN 'delivered' WHEN 4 THEN 'reshipped'
                                    WHEN 3 THEN 'shipped' WHEN 2 THEN 'packed' ELSE 'pending' END
             END AS shipment_state,
             COALESCE(s.ship_count, 0) AS shipment_count,
             COALESCE(s.has_draft, false) AS has_draft,
             COALESCE(s.draft_needs_recovery, false) AS draft_needs_recovery,
             COALESCE(s.push_outstanding, false) AS push_outstanding,
             COALESCE(s.tracking_numbers, '') AS tracking_numbers,
             COALESCE(s.label_cost_total, 0) AS label_cost_total
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      LEFT JOIN (
        -- all packing math uses the EFFECTIVE quantity, and locally-removed
        -- lines vanish from fulfillment entirely
        SELECT oi.order_id,
               string_agg(p.sku_code || ' (' || COALESCE(oi.qty_override, oi.qty) || ')', '; ' ORDER BY p.sku_code)
                 FILTER (WHERE NOT oi.direct_ship AND oi.removed_at IS NULL) AS items_summary,
               COALESCE(SUM(COALESCE(oi.qty_override, oi.qty)) FILTER (WHERE NOT oi.direct_ship AND oi.removed_at IS NULL), 0) AS item_count,
               -- what is STILL to pack after existing shipments/drafts
               string_agg(p.sku_code || ' (' || GREATEST(COALESCE(oi.qty_override, oi.qty) - att.attributed, 0) || ')', '; ' ORDER BY p.sku_code)
                 FILTER (WHERE NOT oi.direct_ship AND oi.removed_at IS NULL
                         AND COALESCE(oi.qty_override, oi.qty) - att.attributed > 0) AS remaining_summary,
               COALESCE(SUM(GREATEST(COALESCE(oi.qty_override, oi.qty) - att.attributed, 0))
                 FILTER (WHERE NOT oi.direct_ship AND oi.removed_at IS NULL), 0) AS remaining_packable_qty,
               COALESCE(SUM(LEAST(att.shipped, COALESCE(oi.qty_override, oi.qty)))
                 FILTER (WHERE NOT oi.direct_ship AND oi.removed_at IS NULL), 0) AS shipped_packable_qty,
               -- per-product remaining for the client-side session pool
               jsonb_agg(jsonb_build_object('product_id', p.id, 'sku', p.sku_code,
                                            'remaining', GREATEST(COALESCE(oi.qty_override, oi.qty) - att.attributed, 0)))
                 FILTER (WHERE NOT oi.direct_ship AND oi.removed_at IS NULL
                         AND COALESCE(oi.qty_override, oi.qty) - att.attributed > 0) AS packable_json,
               string_agg(p.sku_code || ' (' || COALESCE(oi.qty_override, oi.qty) || ')', '; ' ORDER BY p.sku_code)
                 FILTER (WHERE oi.direct_ship AND oi.removed_at IS NULL) AS direct_items_summary,
               -- what the vendor STILL owes — the direct tab's row text and
               -- the bulk button's confirm show this, so the confirmation
               -- lists exactly the lines the bulk action will stamp
               string_agg(p.sku_code || ' (' || COALESCE(oi.qty_override, oi.qty) || ')', '; ' ORDER BY p.sku_code)
                 FILTER (WHERE oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL) AS direct_outstanding_summary,
               -- the ids behind that summary — the bulk button passes them
               -- back so the stamp is anchored to exactly what was confirmed
               string_agg(oi.id::text, ',' ORDER BY oi.id)
                 FILTER (WHERE oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL) AS direct_outstanding_ids,
               bool_and(oi.direct_ship) FILTER (WHERE oi.removed_at IS NULL) AS all_direct,
               bool_or(oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL) AS direct_outstanding
        FROM order_items oi
        JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
        JOIN products p ON p.id = gbp.product_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(sum(si.qty), 0) AS attributed,
                 COALESCE(sum(si.qty) FILTER (WHERE sh.finalized_at IS NOT NULL), 0) AS shipped
          FROM shipment_items si
          JOIN shipments sh ON sh.id = si.shipment_id
          WHERE si.order_item_id = oi.id
            AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
        ) att ON true
        GROUP BY oi.order_id
      ) it ON it.order_id = o.id
      LEFT JOIN LATERAL (
        SELECT count(*) AS ship_count,
               bool_or(sh.finalized_at IS NULL) AS has_draft,
               -- a draft whose Shippo POST was dispatched but never finalized
               -- may carry a PAID label — surface it loudly
               bool_or(sh.finalized_at IS NULL AND sh.purchase_attempted_at IS NOT NULL) AS draft_needs_recovery,
               bool_or(sh.status = 'packed') AS any_packed,
               bool_or(sh.status IN ('shipped','delivered','reshipped')) AS any_shipped,
               string_agg(sh.carrier || ' ' || sh.tracking_number, ', ' ORDER BY sh.created_at)
                 FILTER (WHERE sh.tracking_number IS NOT NULL) AS tracking_numbers,
               bool_or(sh.finalized_at IS NOT NULL AND sh.b44_pushed_at IS NULL
                       AND sh.status IN ('shipped','delivered','reshipped')) AS push_outstanding,
               COALESCE(sum(sh.label_cost_usd), 0) AS label_cost_total,
               max(CASE sh.status WHEN 'delivered' THEN 5 WHEN 'reshipped' THEN 4
                                  WHEN 'shipped' THEN 3 WHEN 'packed' THEN 2 ELSE 1 END) AS max_rank
        FROM shipments sh
        WHERE sh.order_id = o.id AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
      ) s ON true
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND o.status NOT IN ('cancelled','refunded')
        -- product filters (both modes look at active PACKABLE lines only)
        AND (COALESCE({{params.product_ids}}::text, '') = ''
          OR (EXISTS (
                SELECT 1 FROM order_items foi
                JOIN group_buy_products fg ON fg.id = foi.group_buy_product_id
                WHERE foi.order_id = o.id AND foi.removed_at IS NULL AND NOT foi.direct_ship
                  AND fg.product_id IN (SELECT pid FROM sel))
              AND ({{params.filter_mode}}::text <> 'only'
                OR NOT EXISTS (
                    SELECT 1 FROM order_items foi2
                    JOIN group_buy_products fg2 ON fg2.id = foi2.group_buy_product_id
                    WHERE foi2.order_id = o.id AND foi2.removed_at IS NULL AND NOT foi2.direct_ship
                      AND fg2.product_id NOT IN (SELECT pid FROM sel)))))
        AND ({{params.stage}}::text = 'all'
          -- ready requires fully collected (matched — or OVER: an overpaid
          -- order is fully collected and shippable) AND no unresolved
          -- payments: an order can read matched (e.g. via write-off/comp)
          -- while a new hash pends — money evidence must be resolved before
          -- shipping. Fully-direct orders leave the pack list — they are the
          -- 'direct' stage. Remaining work (not "no shipment yet") is the
          -- membership test: a partially shipped order STAYS ready until its
          -- last packable unit is drafted, and returns if a refund voids one.
          OR ({{params.stage}}::text = 'ready' AND NOT o.hold_shipping AND r.recon_status IN ('matched', 'over') AND r.pending_payment_count = 0
              AND NOT COALESCE(it.all_direct, false)
              AND COALESCE(it.remaining_packable_qty, 0) > 0)
          -- same money gates as ready, but for VENDOR-shipped lines: any order
          -- (fully direct or mixed) with a direct line the vendor hasn't
          -- shipped yet. Deliberately NOT gated on the local shipment rows —
          -- a mixed order's local half packing/shipping must not hide its
          -- outstanding vendor half. Rows leave via "Mark vendor shipped".
          OR ({{params.stage}}::text = 'direct' AND NOT o.hold_shipping AND r.recon_status IN ('matched', 'over') AND r.pending_payment_count = 0
              AND COALESCE(it.direct_outstanding, false))
          OR ({{params.stage}}::text = 'held' AND o.hold_shipping)
          OR ({{params.stage}}::text = 'packed' AND COALESCE(s.any_packed, false))
          OR ({{params.stage}}::text = 'shipped' AND COALESCE(s.any_shipped, false)))
      ORDER BY o.order_number
      LIMIT 1000
    `,
  });
}

export default listFulfillmentQueue;
