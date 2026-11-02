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
 * values are trimmed and the state upper-cased. Any invalid value, a
 * cancelled/refunded order, or an order that is not manual refuses the
 * whole edit (zero rows).
 *
 * Safe against a box in flight: a draft's purchase claim and finalize both
 * compare the draft's destination to the order's live address, so an edit
 * after a quote refuses that purchase instead of shipping to the old one.
 * Takes the 42001 per-order lock like every ship-state writer. Audited
 * 'manual_order_address_set' with the old and new address.
 */
function setManualOrderAddress() {
  return action('setManualOrderAddress', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42001, ({{params.order_id}})::int) AS locked
      ), prev AS (
        SELECT o.id, o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code
        FROM lck, orders o
        WHERE o.id = {{params.order_id}}::bigint
      ), upd AS (
        UPDATE orders o SET
          address_line1 = btrim({{params.street1}}::text),
          address_line2 = NULLIF(btrim({{params.street2}}::text), ''),
          city = btrim({{params.city}}::text),
          state_code = upper(btrim({{params.state}}::text)),
          postal_code = btrim({{params.zip}}::text)
        FROM lck
        WHERE o.id = {{params.order_id}}::bigint
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
                                  'city', upd.city, 'state', upd.state_code, 'zip', upd.postal_code),
               (SELECT jsonb_build_object('street1', p.address_line1, 'street2', p.address_line2,
                                          'city', p.city, 'state', p.state_code, 'zip', p.postal_code)
                FROM prev p)
        FROM upd
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default setManualOrderAddress;
