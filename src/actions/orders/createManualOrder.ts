import { action } from '@uibakery/data';

/**
 * Create an order that exists ONLY in this app — a customer order the
 * ordering app never saw (a side deal, a make-good, an order taken over
 * chat). It is the one order path that is not importUpsertOrder, so it keeps
 * to the import's shape and stays invisible to every upstream control:
 *
 *  - customer matched or created exactly as the import does (email citext,
 *    else an email-less customer with the same display name);
 *  - external_id NULL and raw_import.source = 'manual': the base44-only
 *    controls (push changes, rail push, deleted-upstream diff, cancel
 *    deleted upstream) gate on external_id / source = 'base44', and the
 *    import's upsert and status sync never touch a manual row;
 *  - every header money column is 0 — the order's lines are added as LOCAL
 *    items (addLocalOrderItem), so v_order_reconciliation bills it at
 *    exactly the local items value, and demand/packing count the lines like
 *    any other order; fees come from setOrderFees, payments from the
 *    existing payment flows;
 *  - placed_at = now(), status 'imported' (recon owns the rest).
 *
 * Refusals (zero inserted rows; the single result row carries `refused`
 * with the reason, so the dialog can say why):
 *  - the campaign is set up for the storefront (storefront.campaign_settings
 *    row): a campaign runs on ONE platform (1790101100), and the trigger
 *    would raise anyway — refused here first with a reason;
 *  - the number is not this campaign's manual shape:
 *    <prefix>-X<NNN>, prefix derived exactly as nextManualOrderNumber does
 *    (the campaign's upstream shape, else the current year). The 'X'
 *    segment is one no upstream can mint, so a manual number can never be
 *    claimed by a later pull or paste;
 *  - the number is already registered (either writer) — the registry's
 *    primary key is the backstop for a race;
 *  - no customer name.
 *
 * Audited 'manual_order_created'. A manual order makes the campaign a
 * non-storefront campaign for good (the one-platform rule refuses storefront
 * setup while it holds orders from another source).
 */
function createManualOrder() {
  return action('createManualOrder', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH shape AS (
        SELECT regexp_replace(o.order_number, '-[^-]*$', '') AS prefix, count(*) AS n
        FROM orders o
        WHERE o.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint
          AND COALESCE(o.raw_import->>'source', '') <> 'manual'
          AND regexp_replace(o.order_number, '-[^-]*$', '') ~ '^[0-9]{4}(-[A-Z0-9]{2,8})?$'
        GROUP BY 1
        ORDER BY n DESC, 1
        LIMIT 1
      ), pfx AS (
        SELECT COALESCE((SELECT prefix FROM shape), to_char(now(), 'YYYY')) AS prefix
      ), chk AS (
        SELECT CASE
          WHEN NOT EXISTS (SELECT 1 FROM group_buys g WHERE g.id = NULLIF({{params.group_buy_id}}::text, '')::bigint)
            THEN 'no such campaign'
          WHEN EXISTS (SELECT 1 FROM storefront.campaign_settings cs
                       WHERE cs.group_buy_id = NULLIF({{params.group_buy_id}}::text, '')::bigint)
            THEN 'storefront campaign'
          WHEN btrim({{params.customer_name}}::text) = ''
            THEN 'no customer name'
          WHEN {{params.order_number}}::text !~ '^[0-9]{4}(-[A-Z0-9]{2,8})?-X[0-9]{3,}$'
               OR regexp_replace({{params.order_number}}::text, '-X[0-9]+$', '') <> (SELECT prefix FROM pfx)
            THEN 'bad number'
          WHEN EXISTS (SELECT 1 FROM order_number_registry r WHERE r.order_number = {{params.order_number}}::text)
            THEN 'number taken'
          ELSE NULL END AS refused
      ), existing AS (
        SELECT id FROM customers
        WHERE (SELECT refused FROM chk) IS NULL
          AND (({{params.email}}::text <> '' AND email = {{params.email}}::citext)
            OR ({{params.email}}::text = '' AND email IS NULL AND display_name = btrim({{params.customer_name}}::text)))
        LIMIT 1
      ), ins_cust AS (
        INSERT INTO customers (email, display_name, discord_username, phone)
        SELECT NULLIF({{params.email}}::text, '')::citext,
               btrim({{params.customer_name}}::text),
               NULLIF({{params.discord}}::text, ''),
               NULLIF({{params.phone}}::text, '')
        WHERE (SELECT refused FROM chk) IS NULL
          AND NOT EXISTS (SELECT 1 FROM existing)
        RETURNING id
      ), cust AS (
        SELECT id FROM existing UNION ALL SELECT id FROM ins_cust
      ), ins AS (
        INSERT INTO orders (
          external_id, order_number, group_buy_id, customer_id, status, payment_rail,
          contact_name, contact_email, contact_phone, discord_username,
          address_line1, address_line2, city, state_code, postal_code,
          subtotal_usd, tip_usd, admin_fee_usd, shipping_fee_usd, shipping_insurance_usd, processor_fee_usd, total_usd,
          placed_at, customer_note, raw_import
        )
        SELECT
          NULL,
          {{params.order_number}}::text,
          NULLIF({{params.group_buy_id}}::text, '')::bigint,
          cust.id,
          'imported',
          {{params.payment_rail}}::payment_rail,
          btrim({{params.customer_name}}::text),
          NULLIF({{params.email}}::text, '')::citext,
          NULLIF({{params.phone}}::text, ''),
          NULLIF({{params.discord}}::text, ''),
          NULLIF({{params.address_line1}}::text, ''),
          NULLIF({{params.address_line2}}::text, ''),
          NULLIF({{params.city}}::text, ''),
          NULLIF(upper(btrim({{params.state_code}}::text)), ''),
          NULLIF({{params.postal_code}}::text, ''),
          0, 0, 0, 0, 0, 0, 0,
          now(),
          NULLIF({{params.customer_note}}::text, ''),
          jsonb_build_object('source', 'manual', 'created_by', {{params.actor}}::text, 'created_at', now())
        FROM cust
        WHERE (SELECT refused FROM chk) IS NULL
        RETURNING id, order_number, customer_id, payment_rail
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'orders', ins.id::text, 'manual_order_created', {{params.actor}}::text,
               jsonb_build_object('order_number', ins.order_number, 'group_buy_id', NULLIF({{params.group_buy_id}}::text, '')::bigint,
                                  'customer_id', ins.customer_id, 'payment_rail', ins.payment_rail)
        FROM ins
        RETURNING row_pk
      )
      SELECT ins.id, ins.order_number, NULL::text AS refused FROM ins
      UNION ALL
      SELECT NULL, NULL, chk.refused FROM chk WHERE chk.refused IS NOT NULL
    `,
  });
}

export default createManualOrder;
