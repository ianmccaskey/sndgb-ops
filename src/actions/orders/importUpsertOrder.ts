import { action } from '@uibakery/data';

/**
 * Idempotent order import from the external ordering app.
 * - Customer is matched by email (case-insensitive); email-less rows match an
 *   existing email-less customer with the same display name before creating one.
 * - The order upserts on order_number (always present), so re-pasting an
 *   export can never duplicate orders — it refreshes them.
 * - order_number is globally unique; if the incoming row's number already
 *   belongs to an order in a DIFFERENT group buy, the update is refused
 *   (RETURNING is empty) rather than hijacking that order.
 * - The full original row is preserved in raw_import.
 */
function importUpsertOrder() {
  return action('importUpsertOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH existing AS (
        SELECT id FROM customers
        WHERE ({{params.email}} <> '' AND email = {{params.email}}::citext)
           OR ({{params.email}} = '' AND email IS NULL AND display_name = {{params.customer_name}})
        LIMIT 1
      ), ins AS (
        INSERT INTO customers (email, display_name, discord_username, phone)
        SELECT NULLIF({{params.email}}::text, '')::citext,
               {{params.customer_name}},
               NULLIF({{params.discord}}::text, ''),
               NULLIF({{params.phone}}::text, '')
        WHERE NOT EXISTS (SELECT 1 FROM existing)
        RETURNING id
      ), cust AS (
        SELECT id FROM existing UNION ALL SELECT id FROM ins
      )
      INSERT INTO orders (
        external_id, order_number, group_buy_id, customer_id, status, payment_rail,
        contact_name, contact_email, contact_phone, discord_username,
        address_line1, address_line2, city, state_code, postal_code,
        subtotal_usd, tip_usd, admin_fee_usd, shipping_fee_usd, processor_fee_usd, total_usd,
        placed_at, customer_note, raw_import
      )
      SELECT
        NULLIF({{params.external_id}}::text, ''),
        {{params.order_number}},
        {{params.group_buy_id}}::bigint,
        cust.id,
        'imported',
        {{params.payment_rail}}::payment_rail,
        {{params.customer_name}},
        NULLIF({{params.email}}::text, '')::citext,
        NULLIF({{params.phone}}::text, ''),
        NULLIF({{params.discord}}::text, ''),
        NULLIF({{params.address_line1}}::text, ''),
        NULLIF({{params.address_line2}}::text, ''),
        NULLIF({{params.city}}::text, ''),
        NULLIF({{params.state_code}}::text, ''),
        NULLIF({{params.postal_code}}::text, ''),
        {{params.subtotal_usd}}::numeric,
        {{params.tip_usd}}::numeric,
        {{params.admin_fee_usd}}::numeric,
        {{params.shipping_fee_usd}}::numeric,
        {{params.processor_fee_usd}}::numeric,
        {{params.total_usd}}::numeric,
        NULLIF({{params.placed_at}}::text, '')::timestamptz,
        NULLIF({{params.customer_note}}::text, ''),
        {{params.raw_import}}::jsonb
      FROM cust
      ON CONFLICT (order_number) DO UPDATE SET
        -- guarded below: never adopt an order that belongs to another campaign
        external_id = COALESCE(EXCLUDED.external_id, orders.external_id),
        payment_rail = EXCLUDED.payment_rail,
        contact_name = EXCLUDED.contact_name,
        contact_email = EXCLUDED.contact_email,
        contact_phone = EXCLUDED.contact_phone,
        discord_username = EXCLUDED.discord_username,
        address_line1 = EXCLUDED.address_line1,
        address_line2 = EXCLUDED.address_line2,
        city = EXCLUDED.city,
        state_code = EXCLUDED.state_code,
        postal_code = EXCLUDED.postal_code,
        subtotal_usd = EXCLUDED.subtotal_usd,
        tip_usd = EXCLUDED.tip_usd,
        admin_fee_usd = EXCLUDED.admin_fee_usd,
        shipping_fee_usd = EXCLUDED.shipping_fee_usd,
        processor_fee_usd = EXCLUDED.processor_fee_usd,
        total_usd = EXCLUDED.total_usd,
        placed_at = EXCLUDED.placed_at,
        customer_note = EXCLUDED.customer_note,
        raw_import = EXCLUDED.raw_import
      WHERE orders.group_buy_id = EXCLUDED.group_buy_id
      RETURNING id
    `,
  });
}

export default importUpsertOrder;
