import { action } from '@uibakery/data';

/**
 * Edit an order line's quantity as an OVERRIDE. Blank clears (back to the
 * ordering app's qty); a value wins over every pull until upstream catches
 * up (importUpsertOrder retires it, gated on the header total moving in the
 * same pull). Billing, demand, vendor owed, and comps all follow the
 * effective quantity.
 *
 * Guards (zero rows = refused): item belongs to the order; order not
 * cancelled/refunded; the line is not removed (restore it first); the order
 * is still in the pack flow (latest shipment pending — an edit after
 * packing would bill for a box that already shipped differently); qty is
 * positive with max 2 decimals, string-checked.
 *
 * Takes the 42001 per-order lock (the effective-qty delta feeds due) and
 * auto-clears a standing write-off when the effective qty actually changes.
 */
function setOrderItemQty() {
  return action('setOrderItemQty', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), prev AS (
        SELECT oi.id, COALESCE(oi.qty_override, oi.qty) AS eff_qty, oi.comp_qty, oi.direct_fulfilled_at
        FROM lck, order_items oi
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
        FOR UPDATE OF oi
      ), upd AS (
        UPDATE order_items oi SET
          qty_override = NULLIF({{params.qty}}::text, '')::numeric,
          -- same persistent-clamp invariant as imports: a comp must never
          -- exceed the effective quantity, and a later qty increase must
          -- never silently re-expand a clamped comp — growing a comp is a
          -- fresh audited decision
          comp_qty = LEAST(oi.comp_qty, COALESCE(NULLIF({{params.qty}}::text, '')::numeric, oi.qty)),
          -- same staleness rule as imports: a recorded vendor fulfillment
          -- goes stale when the obligation's quantity changes — the line
          -- re-enters the Direct ship queue instead of hiding real work
          direct_fulfilled_at = CASE
            WHEN oi.direct_ship AND oi.direct_fulfilled_at IS NOT NULL
                 AND COALESCE(NULLIF({{params.qty}}::text, '')::numeric, oi.qty)
                     IS DISTINCT FROM COALESCE(oi.qty_override, oi.qty)
              THEN NULL
            ELSE oi.direct_fulfilled_at
          END
        FROM lck, orders o
        WHERE oi.id = {{params.item_id}}::bigint
          AND oi.order_id = {{params.order_id}}::bigint
          AND o.id = oi.order_id
          AND o.status NOT IN ('cancelled', 'refunded')
          AND oi.removed_at IS NULL
          AND ({{params.qty}}::text = '' OR ({{params.qty}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND NULLIF({{params.qty}}::text, '')::numeric > 0))
          -- a local edit must not CREATE or DESTROY a split: the split fee is
          -- charged by the ordering app and snapshotted from the upstream
          -- qty, so a whole<->half transition here would move real money
          -- (+/- the fee) that neither billed math nor the push carries.
          -- Half-to-half (0.5 -> 1.5) and whole-to-whole edits stay allowed.
          AND ((COALESCE(NULLIF({{params.qty}}::text, '')::numeric, oi.qty) % 1 = 0)
               = (oi.qty % 1 = 0))
          AND COALESCE((
            SELECT sh.status::text FROM shipments sh
            WHERE sh.order_id = oi.order_id
            ORDER BY sh.created_at DESC LIMIT 1
          ), 'pending') = 'pending'
        RETURNING oi.id, oi.qty, oi.qty_override, COALESCE(oi.qty_override, oi.qty) AS eff_qty, oi.comp_qty, oi.direct_fulfilled_at
      ), comp_clamp_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', upd.id::text, 'comp_clamped_on_qty_edit', {{params.actor}},
               jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                  'old_comp_qty', prev.comp_qty, 'new_comp_qty', upd.comp_qty,
                                  'new_effective_qty', upd.eff_qty)
        FROM upd
        JOIN prev ON prev.id = upd.id
        WHERE upd.comp_qty < prev.comp_qty
        RETURNING row_pk
      ), wo_clear AS (
        DELETE FROM order_writeoffs w
        USING upd, prev
        WHERE w.order_id = {{params.order_id}}::bigint
          AND prev.id = upd.id
          AND (prev.eff_qty IS DISTINCT FROM upd.eff_qty
               OR prev.comp_qty IS DISTINCT FROM upd.comp_qty)
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', {{params.actor}},
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'item_qty_edit')
        FROM wo_clear
        RETURNING row_pk
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', upd.id::text, 'item_qty_override_set', {{params.actor}},
               jsonb_build_object('order_id', {{params.order_id}}::bigint,
                                  'imported_qty', upd.qty,
                                  'qty_override', upd.qty_override,
                                  'old_effective_qty', (SELECT eff_qty FROM prev),
                                  'new_effective_qty', upd.eff_qty,
                                  'direct_fulfillment_reset',
                                    ((SELECT direct_fulfilled_at FROM prev) IS NOT NULL AND upd.direct_fulfilled_at IS NULL))
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default setOrderItemQty;
