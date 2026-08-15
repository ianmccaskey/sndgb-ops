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
 * - Takes the per-order advisory lock (class 42001) when the order already
 *   exists: the update can change total_usd, which feeds the write-off cap
 *   (due = billed - comps - write-off) — total changes must serialize with
 *   cap reads. New orders have nothing to protect (no write-off can exist).
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
      ), lck AS (
        SELECT pg_advisory_xact_lock(42001, o.id::int) AS locked
        FROM orders o
        WHERE o.order_number = {{params.order_number}}
      ), prev AS (
        SELECT o.id, o.total_usd
        FROM lck, orders o
        WHERE o.order_number = {{params.order_number}}
      ), up AS (
      INSERT INTO orders (
        external_id, order_number, group_buy_id, customer_id, status, payment_rail,
        contact_name, contact_email, contact_phone, discord_username,
        address_line1, address_line2, city, state_code, postal_code,
        subtotal_usd, tip_usd, admin_fee_usd, shipping_fee_usd, shipping_insurance_usd, processor_fee_usd, total_usd,
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
        COALESCE(NULLIF({{params.shipping_insurance_usd}}::text, '')::numeric, 0),
        {{params.processor_fee_usd}}::numeric,
        {{params.total_usd}}::numeric,
        NULLIF({{params.placed_at}}::text, '')::timestamptz,
        NULLIF({{params.customer_note}}::text, ''),
        {{params.raw_import}}::jsonb
      FROM cust
      -- scalar dependency (not a join): lck is empty for NEW orders and must
      -- not suppress the insert; referencing it forces the lock to be taken
      -- first when the order exists
      WHERE (SELECT COUNT(*) FROM lck) >= 0
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
        -- blank = the source doesn't know insurance (paste layout has no
        -- column): keep the stored value so a paste re-import can never
        -- erase what a pull recorded
        shipping_insurance_usd = COALESCE(NULLIF({{params.shipping_insurance_usd}}::text, '')::numeric, orders.shipping_insurance_usd),
        -- a fee override RETIRES when upstream catches up to it (a pushed
        -- edit coming back, or an upstream fix to the same value): the
        -- effective fee is unchanged in that instant, and clearing lets
        -- future upstream fee changes flow again instead of being masked.
        -- GATED on the header total moving in the SAME pull: a partial push
        -- that landed fee fields but not the total must NOT retire — the
        -- override (and its billed delta) stays alive, keeping the intended
        -- bill and the visible marker until the totals repair runs. This
        -- gate needs no total arithmetic, so cash-rail gross-up (which lives
        -- only in the total) can't false it.
        admin_fee_override_usd = CASE
          WHEN orders.admin_fee_override_usd IS NOT NULL AND EXCLUDED.admin_fee_usd = orders.admin_fee_override_usd
               AND EXCLUDED.total_usd IS DISTINCT FROM orders.total_usd
            THEN NULL ELSE orders.admin_fee_override_usd END,
        shipping_fee_override_usd = CASE
          WHEN orders.shipping_fee_override_usd IS NOT NULL AND EXCLUDED.shipping_fee_usd = orders.shipping_fee_override_usd
               AND EXCLUDED.total_usd IS DISTINCT FROM orders.total_usd
            THEN NULL ELSE orders.shipping_fee_override_usd END,
        shipping_insurance_override_usd = CASE
          WHEN orders.shipping_insurance_override_usd IS NOT NULL
               AND COALESCE(NULLIF({{params.shipping_insurance_usd}}::text, '')::numeric, orders.shipping_insurance_usd) = orders.shipping_insurance_override_usd
               AND EXCLUDED.total_usd IS DISTINCT FROM orders.total_usd
            THEN NULL ELSE orders.shipping_insurance_override_usd END,
        tip_override_usd = CASE
          WHEN orders.tip_override_usd IS NOT NULL AND EXCLUDED.tip_usd = orders.tip_override_usd
               AND EXCLUDED.total_usd IS DISTINCT FROM orders.total_usd
            THEN NULL ELSE orders.tip_override_usd END,
        processor_fee_usd = EXCLUDED.processor_fee_usd,
        total_usd = EXCLUDED.total_usd,
        placed_at = EXCLUDED.placed_at,
        customer_note = EXCLUDED.customer_note,
        raw_import = EXCLUDED.raw_import
      WHERE orders.group_buy_id = EXCLUDED.group_buy_id
      RETURNING id, total_usd
      ), adopt AS (
        -- ATOMIC with the total update: the incoming item list carries the
        -- SKUs upstream now knows, so any matching LOCALLY-ADDED row flips
        -- to 'import' in the same statement the header total lands — a
        -- partial import failure between this call and the per-item upserts
        -- can never leave a product billed twice (once inside the new total
        -- and again as a local add-on). The later item upsert then just
        -- refreshes qty on an already-imported row.
        UPDATE order_items oi SET item_source = 'import'
        FROM up,
             jsonb_to_recordset({{params.items}}::jsonb) AS x(sku text, qty numeric)
             JOIN products p ON p.sku_code = x.sku
             JOIN group_buy_products gbp ON gbp.product_id = p.id
               AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
        WHERE oi.order_id = up.id
          AND oi.group_buy_product_id = gbp.id
          AND oi.item_source = 'local'
        RETURNING oi.id
      ), adopt_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', adopt.id::text, 'local_item_adopted_by_import', 'import',
               jsonb_build_object('order_id', (SELECT id FROM up))
        FROM adopt
        RETURNING row_pk
      ), retire_qty AS (
        -- a qty override RETIRES when upstream's incoming qty equals it AND
        -- the header total moved in this same pull — a partial push (qty
        -- landed, total stuck) keeps the override and its billed delta alive
        -- until the totals repair runs (same gate as the fee overrides)
        UPDATE order_items oi SET qty_override = NULL
        FROM up, prev,
             jsonb_to_recordset({{params.items}}::jsonb) AS x(sku text, qty numeric)
             JOIN products p2 ON p2.sku_code = x.sku
             JOIN group_buy_products gbp2 ON gbp2.product_id = p2.id
               AND gbp2.group_buy_id = {{params.group_buy_id}}::bigint
        WHERE oi.order_id = up.id
          AND prev.id = up.id
          AND oi.group_buy_product_id = gbp2.id
          AND oi.qty_override IS NOT NULL
          AND x.qty = oi.qty_override
          AND prev.total_usd IS DISTINCT FROM up.total_usd
        RETURNING oi.id
      ), retire_qty_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', retire_qty.id::text, 'item_qty_override_retired', 'import',
               jsonb_build_object('order_id', (SELECT id FROM up))
        FROM retire_qty
        RETURNING row_pk
      ), retire_removed AS (
        -- a locally-removed line truly deletes only when upstream dropped
        -- the product AND the total moved in the same pull; the ungated
        -- prune skips removed rows, so a partial push (item gone upstream,
        -- total stuck) keeps the marker and the billed deduction intact
        DELETE FROM order_items oi
        USING up, prev
        WHERE oi.order_id = up.id
          AND prev.id = up.id
          AND oi.removed_at IS NOT NULL
          AND prev.total_usd IS DISTINCT FROM up.total_usd
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_to_recordset({{params.items}}::jsonb) AS x(sku text, qty numeric)
            JOIN products p3 ON p3.sku_code = x.sku
            JOIN group_buy_products gbp3 ON gbp3.product_id = p3.id
              AND gbp3.group_buy_id = {{params.group_buy_id}}::bigint
            WHERE gbp3.id = oi.group_buy_product_id
          )
        RETURNING oi.id, oi.group_buy_product_id, oi.qty, oi.unit_price_usd
      ), retire_removed_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', retire_removed.id::text, 'removed_item_retired_by_import', 'import',
               jsonb_build_object('order_id', (SELECT id FROM up),
                                  'group_buy_product_id', retire_removed.group_buy_product_id,
                                  'qty', retire_removed.qty, 'unit_price_usd', retire_removed.unit_price_usd)
        FROM retire_removed
        RETURNING row_pk
      ), wo_clear AS (
        -- a CHANGED billed total invalidates a standing write-off (the
        -- forgiven shortfall was computed against the old total): auto-clear
        -- it, audited. Unchanged totals — the routine re-import case — leave
        -- write-offs alone (IS DISTINCT FROM guard). An adoption also moves
        -- due (the local extra-billing stops), so it clears too.
        DELETE FROM order_writeoffs w
        USING up, prev
        WHERE w.order_id = up.id
          AND prev.id = up.id
          AND (prev.total_usd IS DISTINCT FROM up.total_usd
               OR EXISTS (SELECT 1 FROM adopt))
        RETURNING w.id, w.order_id, w.amount_usd
      ), wo_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_writeoffs', wo_clear.id::text, 'writeoff_auto_cleared', 'import',
               jsonb_build_object('order_id', wo_clear.order_id, 'amount_usd', wo_clear.amount_usd, 'trigger', 'import_total_change')
        FROM wo_clear
        RETURNING row_pk
      )
      SELECT id FROM up
    `,
  });
}

export default importUpsertOrder;
