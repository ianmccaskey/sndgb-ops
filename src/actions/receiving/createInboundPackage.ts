import { action } from '@uibakery/data';

/**
 * Create an inbound package DRAFT (committed_at NULL — editable until
 * committed) ATOMICALLY with its content lines: params.items is a jsonb
 * array [{product_id, qty}] and the package only inserts when EVERY line
 * is valid (positive qty, max 2 decimals, at least one line) — a partial
 * package that later commits with missing contents would understate
 * inventory. The partial unique index refuses a second ACTIVE package on
 * the same (carrier, tracking) — the page catches the 23505 throw and
 * explains. Carrier is a Shippo token (usps/ups/fedex/...). The vendor
 * tag (optional) is quality-checked HERE, not just in the picker: it
 * must be an active, non-JM vendor with a live non-COA product line in
 * the SUBMITTED campaign — COA vendors, JM, and product-less vendor rows
 * are unrepresentable regardless of client state. Which campaign the
 * pair is validated against is client-supplied (the selected campaign
 * exists only as client state in this two-admin app), so cross-campaign
 * binding is UX-level per the app's client-trust precedent; the tag
 * itself is informational with no money impact. Audited.
 */
function createInboundPackage() {
  return action('createInboundPackage', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH input_items AS (
        SELECT (x->>'product_id')::bigint AS product_id, x->>'qty' AS qty_text
        FROM jsonb_array_elements({{params.items}}::jsonb) x
      ),
      ok AS (
        SELECT count(*) AS n,
               bool_and(qty_text ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND qty_text::numeric > 0) AS all_valid
        FROM input_items
      ),
      ins AS (
        INSERT INTO inbound_packages (receive_address_id, vendor_id, carrier, tracking_number, note, created_by)
        SELECT {{params.receive_address_id}}::bigint,
               NULLIF({{params.vendor_id}}::text, '')::bigint,
               LOWER(TRIM({{params.carrier}})),
               -- canonical UPPER: UPS-style numbers are case-insensitive,
               -- and the active-uniqueness guard must see 1Z... and 1z...
               -- as the same parcel
               UPPER(TRIM({{params.tracking_number}})),
               NULLIF(TRIM({{params.note}}::text), ''),
               {{params.actor}}
        WHERE TRIM({{params.carrier}}) <> '' AND TRIM({{params.tracking_number}}) <> ''
          AND EXISTS (SELECT 1 FROM receive_addresses ra WHERE ra.id = {{params.receive_address_id}}::bigint AND ra.active)
          AND (NULLIF({{params.vendor_id}}::text, '') IS NULL
               OR EXISTS (
                 SELECT 1 FROM vendors v
                 JOIN group_buy_products gbp ON gbp.vendor_id = v.id
                 JOIN products pr ON pr.id = gbp.product_id
                 WHERE v.id = NULLIF({{params.vendor_id}}::text, '')::bigint
                   AND v.active
                   AND UPPER(v.code) <> 'JM'
                   AND gbp.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
                   AND gbp.status = 'active'
                   AND pr.sku_code !~* '^coa'
               ))
          AND (SELECT n > 0 AND all_valid FROM ok)
        RETURNING id, receive_address_id, carrier, tracking_number
      ),
      items_ins AS (
        INSERT INTO inbound_package_items (package_id, product_id, qty)
        SELECT ins.id, ii.product_id, ii.qty_text::numeric
        FROM ins, input_items ii
        RETURNING id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'inbound_packages', ins.id::text, 'package_created', {{params.actor}},
             jsonb_build_object('receive_address_id', ins.receive_address_id, 'carrier', ins.carrier,
                                'tracking_number', ins.tracking_number,
                                'items', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty_text)) FROM input_items),
                                'item_count', (SELECT count(*) FROM items_ins))
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default createInboundPackage;
