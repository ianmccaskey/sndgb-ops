import { action } from '@uibakery/data';

/**
 * Mark an order's vendor-direct lines as shipped by the vendor (or undo).
 * Sets direct_fulfilled_at; the direct-tab row disappears once nothing is
 * outstanding. Three targeting modes:
 *  - item_id: exactly ONE line (order-sheet control) — partial vendor
 *    shipments, e.g. two direct SKUs from different vendors.
 *  - fulfilled=true + expected_ids (CSV): the queue dialog's CHOSEN lines
 *    (a subset is fine — the operator picks which lines the vendor's box
 *    covered). ANCHORED all-or-nothing: every chosen id must still be an
 *    outstanding direct line; if ANY changed meanwhile (import reset,
 *    removal, already stamped elsewhere) the whole call refuses (zero
 *    rows) so the operator re-confirms — one shared tracking must never
 *    stamp onto half its lines. Optional vendor_carrier/vendor_tracking
 *    record the VENDOR's label on the stamped lines (canonical compact
 *    tracking, lowercase carrier); undo clears them.
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
      WITH lck AS (
        -- same write boundary as every item mutation: serializes with
        -- imports/edits/shipment transitions on this order
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), inp AS (
        SELECT NULLIF({{params.item_id}}::text, '')::bigint AS item_id,
               string_to_array(NULLIF({{params.expected_ids}}::text, ''), ',')::bigint[] AS exp_ids,
               {{params.fulfilled}}::boolean AS fulfilled,
               NULLIF(LOWER(TRIM({{params.vendor_carrier}}::text)), '') AS v_carrier,
               NULLIF(regexp_replace(UPPER(TRIM({{params.vendor_tracking}}::text)), '\\s', '', 'g'), '') AS v_tracking
        FROM lck
      ), upd AS (
        UPDATE order_items oi SET
          direct_fulfilled_at = CASE WHEN inp.fulfilled THEN now() ELSE NULL END,
          -- a MANUAL fulfillment is owned by no transfer, and an UNDO
          -- releases whichever transfer owned it — either way this
          -- pointer clears, so the order sheet never resurrects an old
          -- label's tracking through a manual mark
          direct_fulfilled_transfer_id = NULL,
          -- the vendor's label: recorded on stamp (when given), cleared on
          -- undo — an unstamped line never carries vendor tracking
          direct_vendor_carrier = CASE WHEN inp.fulfilled THEN inp.v_carrier ELSE NULL END,
          direct_vendor_tracking = CASE WHEN inp.fulfilled THEN inp.v_tracking ELSE NULL END
        FROM inp, orders o
        WHERE oi.order_id = {{params.order_id}}::bigint
          AND o.id = oi.order_id
          -- active orders only. DELIBERATE EXCEPTION to the pack-flow gate:
          -- vendor completion is independent of the local box by design — a
          -- mixed order's local half packs/ships while the vendor half is
          -- still owed, so this action must stay usable after local shipping
          AND o.status NOT IN ('cancelled', 'refunded')
          AND oi.direct_ship
          AND oi.removed_at IS NULL
          AND ((inp.fulfilled AND oi.direct_fulfilled_at IS NULL)
               OR (NOT inp.fulfilled AND oi.direct_fulfilled_at IS NOT NULL))
          AND (
            -- one specific line
            (inp.item_id IS NOT NULL AND oi.id = inp.item_id)
            -- chosen-lines fulfill: only the confirmed ids...
            OR (inp.item_id IS NULL AND inp.fulfilled
                AND inp.exp_ids IS NOT NULL
                AND oi.id = ANY(inp.exp_ids)
                -- ...and only while EVERY confirmed id is still an
                -- outstanding direct line — a chosen line that reset,
                -- vanished, or got stamped elsewhere refuses the WHOLE
                -- call (all-or-nothing: one shared tracking must never
                -- stamp onto half its lines). A subset of the order's
                -- outstanding lines is legitimate — unchosen lines simply
                -- stay outstanding.
                AND NOT EXISTS (
                  SELECT 1 FROM unnest(inp.exp_ids) eid
                  LEFT JOIN order_items ok
                    ON ok.id = eid
                   AND ok.order_id = {{params.order_id}}::bigint
                   AND ok.direct_ship AND ok.direct_fulfilled_at IS NULL
                   AND ok.removed_at IS NULL
                  WHERE ok.id IS NULL
                ))
            -- bulk undo: every fulfilled line (adds work back — safe)
            OR (inp.item_id IS NULL AND NOT inp.fulfilled)
          )
        RETURNING oi.id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'order_items', {{params.order_id}}::text,
             CASE WHEN {{params.fulfilled}}::boolean THEN 'direct_marked_fulfilled' ELSE 'direct_fulfillment_undone' END,
             {{params.actor}}::text,
             jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                'item_ids', (SELECT jsonb_agg(upd.id) FROM upd),
                                'fulfilled', {{params.fulfilled}}::boolean,
                                'vendor_carrier', (SELECT inp.v_carrier FROM inp),
                                'vendor_tracking', (SELECT inp.v_tracking FROM inp))
      WHERE EXISTS (SELECT 1 FROM upd)
      RETURNING row_pk AS id
    `,
  });
}

export default markOrderDirectFulfilled;
