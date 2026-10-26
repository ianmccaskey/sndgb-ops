import { action } from '@uibakery/data';

/**
 * Record ONE vendor payment as a batch (1790102100): its product lines,
 * an optional freight portion, and the SENDS that carried the money — one
 * per on-chain transfer, each from its own wallet, so a payment made as
 * "$20,000 on SOL + $13,025 on ETH" is one record whose kits stay whole
 * per product while the rail cards see each wallet's own outflow.
 *
 * All or nothing: the batch, every line, the freight row and every send
 * insert together, or nothing inserts and the result row says why
 * (`refused`, one entry per problem). The caller never has to re-record
 * half a payment.
 *
 * params.lines  jsonb [{group_buy_product_id, kits_qty, amount_usd,
 *                       allow_over, confirmed_owed}]
 * params.sends  jsonb [{wallet_id, amount_usd, method, tx_ref}]
 * params.freight_usd / allow_over_freight / confirmed_freight_owed as in
 * the single-row recorder this replaces.
 *
 * Guards are the ones the per-line recorder enforced, re-read under the
 * per-vendor+campaign advisory lock (42002) so two recorders cannot both
 * pass the same remaining figure:
 *  - a line's product must be THIS vendor's in THIS campaign; one line per
 *    product; positive whole-or-2dp kits and a positive $ value;
 *  - kits beyond what the product is still owed refuse unless the operator
 *    confirmed the over-buy AGAINST the owed figure sent with the line
 *    (confirmed_owed); if owed shrank meanwhile the confirmation is stale
 *    and refuses rather than widening the over-buy silently;
 *  - freight beyond the vendor's remaining freight refuses the same way
 *    (allow_over_freight + confirmed_freight_owed), and freight is never
 *    more than the batch total;
 *  - every send names an ACTIVE wallet and a positive 2dp amount;
 *  - the sends total EQUALS the lines total + freight, to the cent (the
 *    deferred DB trigger re-checks this at commit for every writer).
 *
 * Audited per line (`insert` on vendor_payments, same shape as before plus
 * batch_id) and once per batch (`vendor_payment_batch_recorded` with every
 * line, send and override).
 */
function addVendorPaymentBatch() {
  return action('addVendorPaymentBatch', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT pg_advisory_xact_lock(42002, hashtext({{params.vendor_id}}::text || ':' || {{params.group_buy_id}}::text)) AS locked
      ), inp_lines AS (
        -- every cast sits inside a CASE on a shape check: a blank or junk
        -- field becomes NULL and a named refusal, never a 22P02 throw
        SELECT x.n,
               CASE WHEN x.e->>'group_buy_product_id' ~ '^[0-9]+$' THEN (x.e->>'group_buy_product_id')::bigint END AS gbp_id,
               CASE WHEN x.e->>'kits_qty' ~ '^[0-9]+(\\.[0-9]{1,2})?$' THEN (x.e->>'kits_qty')::numeric END AS kits_n,
               CASE WHEN x.e->>'amount_usd' ~ '^[0-9]+(\\.[0-9]{1,2})?$' THEN (x.e->>'amount_usd')::numeric END AS amt_n,
               COALESCE(x.e->>'allow_over', '') = 'true' AS allow_over,
               CASE WHEN x.e->>'confirmed_owed' ~ '^-?[0-9]+(\\.[0-9]{1,2})?$' THEN (x.e->>'confirmed_owed')::numeric END AS confirmed_owed
        FROM jsonb_array_elements(COALESCE(NULLIF({{params.lines}}::text, ''), '[]')::jsonb) WITH ORDINALITY AS x(e, n)
      ), inp_sends AS (
        SELECT x.n,
               CASE WHEN x.e->>'wallet_id' ~ '^[0-9]+$' THEN (x.e->>'wallet_id')::bigint END AS wallet_id,
               CASE WHEN x.e->>'amount_usd' ~ '^[0-9]+(\\.[0-9]{1,2})?$' THEN (x.e->>'amount_usd')::numeric END AS amt_n,
               NULLIF(btrim(COALESCE(x.e->>'method', '')), '') AS method,
               NULLIF(btrim(COALESCE(x.e->>'tx_ref', '')), '') AS tx_ref
        FROM jsonb_array_elements(COALESCE(NULLIF({{params.sends}}::text, ''), '[]')::jsonb) WITH ORDINALITY AS x(e, n)
      ), inp_freight AS (
        SELECT NULLIF(btrim({{params.freight_usd}}::text), '') AS f_text,
               CASE WHEN btrim({{params.freight_usd}}::text) ~ '^[0-9]+(\\.[0-9]{1,2})?$' THEN btrim({{params.freight_usd}}::text)::numeric END AS f_n,
               {{params.allow_over_freight}}::text = 'true' AS allow_over,
               CASE WHEN {{params.confirmed_freight_owed}}::text ~ '^-?[0-9]+(\\.[0-9]{1,2})?$' THEN {{params.confirmed_freight_owed}}::text::numeric END AS confirmed
      ), cur_lines AS (
        -- kits still owed per line's product, read AFTER the lock.
        -- ordered_kits, not final_count: the vendor sells WHOLE kits
        SELECT l.n, l.gbp_id, p.sku_code,
               gbp.id IS NOT NULL AS product_ok,
               m.ordered_kits - COALESCE((
                 SELECT SUM(COALESCE(vp2.kits_qty, 0))
                 FROM vendor_payments vp2
                 WHERE vp2.group_buy_product_id = gbp.id
               ), 0) AS kits_remaining
        FROM lck, inp_lines l
        LEFT JOIN group_buy_products gbp
          ON gbp.id = l.gbp_id
         AND gbp.vendor_id = {{params.vendor_id}}::bigint
         AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
        LEFT JOIN products p ON p.id = gbp.product_id
        LEFT JOIN v_moq_progress m ON m.group_buy_product_id = gbp.id
      ), cur_freight AS (
        SELECT (
          SELECT vb.freight_demand_usd - vb.freight_paid_usd
          FROM v_vendor_balances vb
          WHERE vb.vendor_id = {{params.vendor_id}}::bigint
            AND vb.group_buy_id = {{params.group_buy_id}}::bigint
        ) AS freight_remaining
        FROM lck
      ), totals AS (
        SELECT (SELECT COALESCE(SUM(amt_n), 0) FROM inp_lines) + COALESCE((SELECT f_n FROM inp_freight), 0) AS lines_total,
               (SELECT COALESCE(SUM(amt_n), 0) FROM inp_sends) AS sends_total,
               (SELECT count(*) FROM inp_lines) AS line_n,
               (SELECT count(*) FROM inp_sends) AS send_n
      ), refusal AS (
        -- one row per problem; the batch inserts only when this is empty.
        -- Every predicate is written POSITIVELY (COALESCE to false) so a
        -- NULL from a missing product or an unparsable field refuses
        -- instead of slipping through a NOT NULL
        SELECT 'line ' || l.n || CASE WHEN c.sku_code IS NOT NULL THEN ' (' || c.sku_code || ')' ELSE '' END AS what,
               CASE
                 WHEN NOT c.product_ok THEN 'not this vendor''s product in this campaign'
                 WHEN l.kits_n IS NULL OR l.kits_n <= 0 THEN 'kits must be a positive count with at most 2 decimals'
                 WHEN l.amt_n IS NULL OR l.amt_n <= 0 THEN 'value must be a positive $ amount with at most 2 decimals'
                 WHEN (SELECT count(*) FROM inp_lines l2 WHERE l2.gbp_id = l.gbp_id) > 1 THEN 'listed twice — one line per product'
                 WHEN NOT (COALESCE(l.kits_n <= c.kits_remaining, false)
                           OR COALESCE(l.allow_over AND c.kits_remaining >= l.confirmed_owed, false))
                   THEN 'exceeds kits still owed (' || COALESCE(c.kits_remaining::text, '?') || ') — press Record again to confirm the over-buy'
               END AS why
        FROM inp_lines l
        JOIN cur_lines c ON c.n = l.n
        UNION ALL
        SELECT 'send ' || s.n,
               CASE
                 WHEN s.wallet_id IS NULL OR NOT EXISTS (SELECT 1 FROM wallets w WHERE w.id = s.wallet_id AND w.active) THEN 'needs an active wallet'
                 WHEN s.amt_n IS NULL OR s.amt_n <= 0 THEN 'amount must be a positive $ amount with at most 2 decimals'
               END
        FROM inp_sends s
        UNION ALL
        SELECT 'freight',
               CASE
                 WHEN f.f_text IS NOT NULL AND f.f_n IS NULL THEN 'must be a $ amount with at most 2 decimals'
                 WHEN COALESCE(f.f_n, 0) > 0 AND f.f_n > t.lines_total THEN 'cannot exceed the payment total'
                 WHEN COALESCE(f.f_n, 0) > 0
                      AND NOT (COALESCE(f.f_n <= cf.freight_remaining, false)
                               OR COALESCE(f.allow_over AND cf.freight_remaining >= f.confirmed, false))
                   THEN 'exceeds freight still owed (' || COALESCE(cf.freight_remaining::text, '?') || ') — press Record again to confirm the override'
               END
        FROM inp_freight f, cur_freight cf, totals t
        UNION ALL
        SELECT 'payment',
               CASE
                 WHEN t.line_n = 0 AND COALESCE((SELECT f_n FROM inp_freight), 0) = 0 THEN 'needs at least one product line or freight'
                 WHEN t.send_n = 0 THEN 'needs at least one send'
                 WHEN t.lines_total <> t.sends_total THEN 'sends total ' || t.sends_total::text || ' does not equal the lines + freight total ' || t.lines_total::text
               END
        FROM totals t
      ), refused AS (
        SELECT what, why FROM refusal WHERE why IS NOT NULL
      ), ins_batch AS (
        INSERT INTO vendor_payment_batches (vendor_id, group_buy_id, paid_on, note, created_by)
        SELECT {{params.vendor_id}}::bigint, {{params.group_buy_id}}::bigint, {{params.paid_on}}::date,
               NULLIF(btrim({{params.note}}::text), ''), {{params.actor}}::text
        FROM lck
        WHERE NOT EXISTS (SELECT 1 FROM refused)
          AND EXISTS (SELECT 1 FROM vendors v WHERE v.id = {{params.vendor_id}}::bigint AND v.active)
        RETURNING id, vendor_id, group_buy_id, paid_on, note, created_at
      ), ins_lines AS (
        -- batched lines carry NO wallet/method/ref: the money is on the
        -- sends (CHECK vendor_payments_batch_money_on_sends)
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, batch_id)
        SELECT b.vendor_id, b.group_buy_id, b.paid_on, l.amt_n, NULL, NULL, NULL, b.note, l.kits_n, NULL, l.gbp_id, b.id
        FROM ins_batch b, inp_lines l
        RETURNING id, amount_usd, kits_qty, group_buy_product_id, batch_id
      ), ins_freight AS (
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, batch_id)
        SELECT b.vendor_id, b.group_buy_id, b.paid_on, f.f_n, NULL, NULL, NULL, b.note, NULL, f.f_n, NULL, b.id
        FROM ins_batch b, inp_freight f
        WHERE COALESCE(f.f_n, 0) > 0
        RETURNING id, amount_usd, freight_usd, batch_id
      ), ins_sends AS (
        INSERT INTO vendor_payment_sends (batch_id, vendor_id, group_buy_id, wallet_id, amount_usd, method, tx_ref)
        SELECT b.id, b.vendor_id, b.group_buy_id, s.wallet_id, s.amt_n, s.method, s.tx_ref
        FROM ins_batch b, inp_sends s
        RETURNING id, wallet_id, amount_usd, method, tx_ref
      ), audit_lines AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', il.id::text, 'insert', {{params.actor}}::text,
               jsonb_build_object('vendor_id', {{params.vendor_id}}::bigint, 'amount_usd', il.amount_usd, 'kits_qty', il.kits_qty,
                                  'freight_usd', NULL, 'group_buy_product_id', il.group_buy_product_id, 'batch_id', il.batch_id,
                                  'over_owed_override', l.allow_over, 'confirmed_owed', l.confirmed_owed,
                                  'owed_at_insert', c.kits_remaining)
        FROM ins_lines il
        JOIN inp_lines l ON l.gbp_id = il.group_buy_product_id
        JOIN cur_lines c ON c.n = l.n
        RETURNING row_pk
      ), audit_freight AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', fr.id::text, 'insert', {{params.actor}}::text,
               jsonb_build_object('vendor_id', {{params.vendor_id}}::bigint, 'amount_usd', fr.amount_usd, 'kits_qty', NULL,
                                  'freight_usd', fr.freight_usd, 'group_buy_product_id', NULL, 'batch_id', fr.batch_id,
                                  'over_freight_override', f.allow_over, 'confirmed_freight_owed', f.confirmed,
                                  'freight_owed_at_insert', cf.freight_remaining)
        FROM ins_freight fr, inp_freight f, cur_freight cf
        RETURNING row_pk
      ), audit_batch AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payment_batches', b.id::text, 'vendor_payment_batch_recorded', {{params.actor}}::text,
               jsonb_build_object('vendor_id', b.vendor_id, 'group_buy_id', b.group_buy_id, 'paid_on', b.paid_on, 'note', b.note,
                                  'lines', (SELECT jsonb_agg(jsonb_build_object('id', id, 'group_buy_product_id', group_buy_product_id, 'kits_qty', kits_qty, 'amount_usd', amount_usd) ORDER BY id) FROM ins_lines),
                                  'freight', (SELECT jsonb_agg(jsonb_build_object('id', id, 'freight_usd', freight_usd)) FROM ins_freight),
                                  'sends', (SELECT jsonb_agg(jsonb_build_object('id', id, 'wallet_id', wallet_id, 'amount_usd', amount_usd, 'method', method, 'tx_ref', tx_ref) ORDER BY id) FROM ins_sends),
                                  'total_usd', (SELECT lines_total FROM totals))
        FROM ins_batch b
        RETURNING row_pk
      )
      -- exactly one result row: the batch id on success, else NULL with
      -- every refusal named (nothing was written)
      SELECT (SELECT id FROM ins_batch) AS batch_id,
             (SELECT jsonb_agg(jsonb_build_object('what', what, 'why', why)) FROM refused) AS refused
    `,
  });
}

export default addVendorPaymentBatch;
