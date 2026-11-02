import { action } from '@uibakery/data';

/**
 * Set the ship-to address of a MANUAL order (createManualOrder: external_id
 * NULL, raw_import.source 'manual'). A manual order's address is written
 * nowhere else — no pull or paste ever touches it — so one created without
 * one could never be packed: every ship path (draft, label purchase, manual
 * record) refuses an order with no street. An imported order's address is
 * the ordering app's and the next pull overwrites it, so those are refused
 * here; fix them upstream.
 *
 * US addresses only (the label path sends country 'US'): street 1, city,
 * a 2-letter state and a 5 or 5+4 ZIP are required, street 2 is optional;
 * values are trimmed and the state upper-cased. Any invalid value refuses
 * the whole edit (zero rows); a cancelled/refunded order or one that is
 * not manual is refused 'order'.
 *
 * A label already made for the current address stays on its box, so the
 * edit never lands silently over one (Codex):
 *  - refused 'purchase' while a draft's label purchase has not settled
 *    (attempted, not finalized, not verified label-free) — finalize would
 *    record that label whatever the address now says;
 *  - refused 'boxes' while a live finalized box (not cancelled, not
 *    refunded, not delivered/returned/failed) is not in ack_box_ids — the
 *    operator is shown those boxes and confirms that the change is for
 *    boxes shipped from now on (one that has not gone out is cancelled or
 *    refunded in the Ship dialog instead). Carrier status is unknown for
 *    most boxes, so "not moving yet" cannot gate the edit by itself.
 * The refusal row carries the boxes ('#'-guarded tracking). Boxes are read
 * FOR UPDATE after the 42001 order lock, so a draft finalized or claimed
 * meanwhile is seen at its latest; a box INSERTED by a manual record that
 * held the lock as this statement began is not, and the Ship dialog flags
 * any manual-order box whose label differs from the current address
 * (listOrderShipments dest_differs). Draft quotes need nothing: the
 * purchase claim compares the draft's destination to the live address.
 * Audited 'manual_order_address_set' with the old and new address and the
 * acknowledged boxes.
 */
function setManualOrderAddress() {
  return action('setManualOrderAddress', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), prev AS (
        SELECT o.id, o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code,
               (o.external_id IS NULL AND o.raw_import->>'source' = 'manual'
                AND o.status NOT IN ('cancelled', 'refunded')) AS editable
        FROM lck, orders o
        WHERE o.id = {{params.order_id}}::bigint
      ), boxes AS (
        SELECT s.id, s.carrier, s.tracking_number, s.status, s.tracking_status,
               s.finalized_at, s.cancelled_at, s.refund_status,
               s.purchase_attempted_at, s.attempt_verified_no_label_at
        FROM lck, shipments s
        WHERE s.order_id = {{params.order_id}}::bigint
        FOR UPDATE OF s
      ), live AS (
        SELECT b.id FROM boxes b
        WHERE b.finalized_at IS NOT NULL
          AND b.cancelled_at IS NULL
          AND COALESCE(b.refund_status, '') <> 'SUCCESS'
          AND b.status::text NOT IN ('delivered', 'reshipped')
          AND COALESCE(b.tracking_status, '') NOT IN ('DELIVERED', 'RETURNED', 'FAILURE')
      ), unsettled AS (
        SELECT b.id FROM boxes b
        WHERE b.finalized_at IS NULL
          AND b.purchase_attempted_at IS NOT NULL
          AND b.attempt_verified_no_label_at IS NULL
      ), gate AS (
        SELECT CASE
          WHEN NOT COALESCE((SELECT editable FROM prev), false) THEN 'order'
          WHEN EXISTS (SELECT 1 FROM unsettled) THEN 'purchase'
          WHEN EXISTS (SELECT 1 FROM live l
                       WHERE NOT (l.id::text = ANY (COALESCE(string_to_array(NULLIF({{params.ack_box_ids}}::text, ''), ','), '{}'::text[]))))
            THEN 'boxes'
          ELSE NULL END AS refused
      ), upd AS (
        UPDATE orders o SET
          address_line1 = btrim({{params.street1}}::text),
          address_line2 = NULLIF(btrim({{params.street2}}::text), ''),
          city = btrim({{params.city}}::text),
          state_code = upper(btrim({{params.state}}::text)),
          postal_code = btrim({{params.zip}}::text)
        FROM lck
        WHERE o.id = {{params.order_id}}::bigint
          AND (SELECT refused FROM gate) IS NULL
          AND o.external_id IS NULL
          AND o.raw_import->>'source' = 'manual'
          AND o.status NOT IN ('cancelled', 'refunded')
          AND btrim({{params.street1}}::text) <> ''
          AND btrim({{params.city}}::text) <> ''
          AND upper(btrim({{params.state}}::text)) ~ '^[A-Z]{2}$'
          AND btrim({{params.zip}}::text) ~ '^[0-9]{5}(-[0-9]{4})?$'
        RETURNING o.id, o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data, old_data)
        SELECT 'orders', upd.id::text, 'manual_order_address_set', {{params.actor}}::text,
               jsonb_build_object('street1', upd.address_line1, 'street2', upd.address_line2,
                                  'city', upd.city, 'state', upd.state_code, 'zip', upd.postal_code,
                                  'acknowledged_boxes', (SELECT COALESCE(jsonb_agg(l.id ORDER BY l.id), '[]'::jsonb) FROM live l)),
               (SELECT jsonb_build_object('street1', p.address_line1, 'street2', p.address_line2,
                                          'city', p.city, 'state', p.state_code, 'zip', p.postal_code)
                FROM prev p)
        FROM upd
        RETURNING row_pk
      )
      SELECT upd.id::text AS id, NULL::text AS refused, NULL::jsonb AS boxes FROM upd
      UNION ALL
      SELECT NULL, g.refused,
             (SELECT jsonb_agg(jsonb_build_object('id', b.id, 'carrier', b.carrier,
                                                  'tracking', '#' || COALESCE(b.tracking_number, ''),
                                                  'unsettled', b.finalized_at IS NULL) ORDER BY b.id)
              FROM boxes b
              WHERE b.id IN (SELECT id FROM live) OR b.id IN (SELECT id FROM unsettled))
      FROM gate g
      WHERE g.refused IS NOT NULL
    `,
  });
}

export default setManualOrderAddress;
