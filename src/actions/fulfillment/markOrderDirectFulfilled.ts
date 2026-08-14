import { action } from '@uibakery/data';

/**
 * Mark an order's vendor-direct lines as shipped by the vendor (or undo).
 * Sets direct_fulfilled_at; the direct-tab row disappears once nothing is
 * outstanding. Three targeting modes:
 *  - item_id: exactly ONE line (order-sheet control) — partial vendor
 *    shipments, e.g. two direct SKUs from different vendors.
 *  - fulfilled=true + expected_ids (CSV): the bulk queue button. ANCHORED to
 *    the ids whose summary the operator confirmed: only those rows stamp,
 *    and if the order's outstanding set changed meanwhile (an import added
 *    or reset a direct line) the whole call refuses (zero rows) so the
 *    operator re-confirms against fresh data — the same stale-confirmation
 *    anchor pattern as the vendor over-buy override.
 *  - fulfilled=false + blank item_id: undo across the order's fulfilled
 *    lines. Deliberately un-anchored — undoing only ADDS work back to the
 *    queue, the safe direction.
 * Independent of the local shipment record on purpose: a mixed order's two
 * halves complete separately. One statement, audited with the touched item
 * ids; zero rows = refusal (wrong state, or stale confirmation).
 */
function markOrderDirectFulfilled() {
  return action('markOrderDirectFulfilled', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.item_id}}::text, '')::bigint AS item_id,
               string_to_array(NULLIF({{params.expected_ids}}::text, ''), ',')::bigint[] AS exp_ids,
               {{params.fulfilled}}::boolean AS fulfilled
      ), upd AS (
        UPDATE order_items oi SET
          direct_fulfilled_at = CASE WHEN inp.fulfilled THEN now() ELSE NULL END
        FROM inp
        WHERE oi.order_id = {{params.order_id}}::bigint
          AND oi.direct_ship
          AND ((inp.fulfilled AND oi.direct_fulfilled_at IS NULL)
               OR (NOT inp.fulfilled AND oi.direct_fulfilled_at IS NOT NULL))
          AND (
            -- one specific line
            (inp.item_id IS NOT NULL AND oi.id = inp.item_id)
            -- bulk fulfill: only the confirmed ids...
            OR (inp.item_id IS NULL AND inp.fulfilled
                AND inp.exp_ids IS NOT NULL
                AND oi.id = ANY(inp.exp_ids)
                -- ...and only while the confirmed set IS the outstanding set —
                -- a line that appeared or reset since the confirmation makes
                -- the whole call refuse rather than stamp unseen work
                AND NOT EXISTS (
                  SELECT 1 FROM order_items oj
                  WHERE oj.order_id = {{params.order_id}}::bigint
                    AND oj.direct_ship AND oj.direct_fulfilled_at IS NULL
                    AND NOT (oj.id = ANY(inp.exp_ids))
                ))
            -- bulk undo: every fulfilled line (adds work back — safe)
            OR (inp.item_id IS NULL AND NOT inp.fulfilled)
          )
        RETURNING oi.id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_items', {{params.order_id}}::text,
             CASE WHEN {{params.fulfilled}}::boolean THEN 'direct_marked_fulfilled' ELSE 'direct_fulfillment_undone' END,
             {{params.actor}},
             jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                'item_ids', (SELECT jsonb_agg(upd.id) FROM upd),
                                'fulfilled', {{params.fulfilled}}::boolean)
      WHERE EXISTS (SELECT 1 FROM upd)
      RETURNING row_pk AS id
    `,
  });
}

export default markOrderDirectFulfilled;
