import { action } from '@uibakery/data';

/**
 * Create an inbound package DRAFT (committed_at NULL — editable until
 * committed). The partial unique index refuses a second ACTIVE package on
 * the same (carrier, tracking) — the page catches the 23505 throw and
 * explains. Carrier is a Shippo token (usps/ups/fedex/...). Audited.
 */
function createInboundPackage() {
  return action('createInboundPackage', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO inbound_packages (receive_address_id, vendor_id, carrier, tracking_number, note, created_by)
        SELECT {{params.receive_address_id}}::bigint,
               NULLIF({{params.vendor_id}}::text, '')::bigint,
               LOWER(TRIM({{params.carrier}})),
               TRIM({{params.tracking_number}}),
               NULLIF(TRIM({{params.note}}::text), ''),
               {{params.actor}}
        WHERE TRIM({{params.carrier}}) <> '' AND TRIM({{params.tracking_number}}) <> ''
          AND EXISTS (SELECT 1 FROM receive_addresses ra WHERE ra.id = {{params.receive_address_id}}::bigint AND ra.active)
        RETURNING id, receive_address_id, carrier, tracking_number
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'inbound_packages', ins.id::text, 'package_created', {{params.actor}},
             jsonb_build_object('receive_address_id', ins.receive_address_id, 'carrier', ins.carrier, 'tracking_number', ins.tracking_number)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default createInboundPackage;
