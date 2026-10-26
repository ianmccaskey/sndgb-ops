-- Codex review of 1790102300 (2026-10-26), two findings:
--
-- 1. admin_adjustments.group_buy_id became NOT NULL, but the existing
--    writers (addAdjustment, commit_stock_plan()) insert without it. A
--    BEFORE INSERT/UPDATE trigger now derives it from the product for every
--    product row — the column is a denormalised scope key, and the
--    product's campaign is the truth. A product row that names a different
--    campaign than its product is refused with the reason (the composite
--    FK would refuse it too, less clearly). addAdjustment also passes it
--    explicitly from now on; the trigger is the backstop for every writer.
--
-- 2. An Other item made the vendor owe money that no payment could record:
--    the batch recorder took product lines (kits) and freight only. A batch
--    now takes an OTHER ITEMS amount too — a vendor_payments line with no
--    product, no kits and no freight, so it moves neither the kit nor the
--    freight ledger. It is capped against the vendor's Other-items owed
--    minus what such lines already paid (v_vendor_balances.other_paid_usd),
--    with the same confirm-then-anchor override the kit and freight caps
--    use. record_vendor_payment_batch gains three params; the old
--    signature is dropped so nothing can call the shape without the cap.

-- ---- 1. campaign key on every adjustment row -----------------------------

CREATE OR REPLACE FUNCTION admin_adjustments_fill_campaign() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_gb BIGINT;
BEGIN
  IF NEW.group_buy_product_id IS NOT NULL THEN
    SELECT gbp.group_buy_id INTO v_gb FROM group_buy_products gbp WHERE gbp.id = NEW.group_buy_product_id;
    IF v_gb IS NULL THEN
      RAISE EXCEPTION 'adjustment names campaign product % which does not exist', NEW.group_buy_product_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.group_buy_id IS NOT NULL AND NEW.group_buy_id <> v_gb THEN
      RAISE EXCEPTION 'adjustment names campaign % but its product belongs to campaign %', NEW.group_buy_id, v_gb
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.group_buy_id := v_gb;
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS admin_adjustments_fill_campaign ON admin_adjustments;
CREATE TRIGGER admin_adjustments_fill_campaign
  BEFORE INSERT OR UPDATE OF group_buy_product_id, group_buy_id ON admin_adjustments
  FOR EACH ROW EXECUTE FUNCTION admin_adjustments_fill_campaign();

-- ---- 2a. what Other-items money the vendor has already received ----------

CREATE OR REPLACE VIEW v_vendor_balances AS
 SELECT v.id AS vendor_id,
    v.code AS vendor_code,
    gb.id AS group_buy_id,
    gb.name AS group_buy_name,
    sum(pp.owed_to_vendor_usd) + sum(
        CASE
            WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
            ELSE 0::numeric
        END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric) AS owed_usd,
    sum(pp.owed_to_vendor_usd) AS product_owed_usd,
    sum(
        CASE
            WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
            ELSE 0::numeric
        END) + COALESCE(df.direct_freight_usd, 0::numeric) AS freight_demand_usd,
    sum(pp.ordered_kits) AS kits_demand,
    COALESCE(vp.paid_usd, 0::numeric) AS paid_usd,
    COALESCE(vp.kits_paid, 0::numeric) AS kits_paid,
    COALESCE(vp.freight_paid_usd, 0::numeric) AS freight_paid_usd,
    sum(pp.owed_to_vendor_usd) + sum(
        CASE
            WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
            ELSE 0::numeric
        END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric) - COALESCE(vp.paid_usd, 0::numeric) AS balance_usd,
        CASE
            WHEN COALESCE(vp.paid_usd, 0::numeric) = 0::numeric THEN 'unpaid'::text
            WHEN COALESCE(vp.paid_usd, 0::numeric) < (sum(pp.owed_to_vendor_usd) + sum(
            CASE
                WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
                ELSE 0::numeric
            END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric)) THEN 'partial'::text
            WHEN COALESCE(vp.paid_usd, 0::numeric) = (sum(pp.owed_to_vendor_usd) + sum(
            CASE
                WHEN pp.final_count > 0::numeric THEN pp.freight_usd * pp.ordered_kits
                ELSE 0::numeric
            END) + COALESCE(df.direct_freight_usd, 0::numeric) + COALESCE(oa.other_owed_usd, 0::numeric)) THEN 'paid'::text
            ELSE 'OVERPAID'::text
        END AS pay_status,
    COALESCE(df.direct_freight_usd, 0::numeric) AS direct_freight_demand_usd,
    COALESCE(oa.other_owed_usd, 0::numeric) AS other_owed_usd,
    -- payment lines with no product and no freight: the Other-items money
    COALESCE(vp.other_paid_usd, 0::numeric) AS other_paid_usd
   FROM v_product_profit pp
     JOIN vendors v ON v.code = pp.vendor_code
     JOIN group_buys gb ON gb.id = pp.group_buy_id
     LEFT JOIN ( SELECT vendor_payments.vendor_id,
            vendor_payments.group_buy_id,
            sum(vendor_payments.amount_usd) AS paid_usd,
            sum(COALESCE(vendor_payments.kits_qty, 0::numeric)) AS kits_paid,
            sum(COALESCE(vendor_payments.freight_usd, 0::numeric)) AS freight_paid_usd,
            sum(vendor_payments.amount_usd) FILTER (WHERE vendor_payments.group_buy_product_id IS NULL AND vendor_payments.freight_usd IS NULL) AS other_paid_usd
           FROM vendor_payments
          GROUP BY vendor_payments.vendor_id, vendor_payments.group_buy_id) vp ON vp.vendor_id = v.id AND vp.group_buy_id = gb.id
     LEFT JOIN ( SELECT v_direct_freight.vendor_id,
            v_direct_freight.group_buy_id,
            sum(v_direct_freight.direct_freight_usd) AS direct_freight_usd
           FROM v_direct_freight
          GROUP BY v_direct_freight.vendor_id, v_direct_freight.group_buy_id) df ON df.vendor_id = v.id AND df.group_buy_id = gb.id
     LEFT JOIN ( SELECT a.vendor_id,
            a.group_buy_id,
            sum(COALESCE(a.expected_usd, 0::numeric)) AS other_owed_usd
           FROM admin_adjustments a
          WHERE a.group_buy_product_id IS NULL
          GROUP BY a.vendor_id, a.group_buy_id) oa ON oa.vendor_id = v.id AND oa.group_buy_id = gb.id
  GROUP BY v.id, v.code, gb.id, gb.name, vp.paid_usd, vp.kits_paid, vp.freight_paid_usd, vp.other_paid_usd, df.direct_freight_usd, oa.other_owed_usd;

-- ---- 2b. the batch recorder takes an Other-items line -------------------

DROP FUNCTION IF EXISTS record_vendor_payment_batch(text, text, text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION record_vendor_payment_batch(
  p_vendor_id text, p_group_buy_id text, p_paid_on text, p_note text,
  p_lines text, p_freight_usd text, p_allow_over_freight text, p_confirmed_freight_owed text,
  p_sends text, p_actor text,
  p_other_usd text, p_allow_over_other text, p_confirmed_other_owed text
) RETURNS TABLE (batch_id bigint, refused jsonb)
LANGUAGE plpgsql VOLATILE AS $fn$
#variable_conflict use_column
BEGIN
  -- serialize recorders per vendor+campaign, in a statement of its own
  PERFORM pg_advisory_xact_lock(42002, hashtext(p_vendor_id::text || ':' || p_group_buy_id::text));
  RETURN QUERY
      WITH inp_lines AS (
        -- every cast sits inside a CASE on a shape check: a blank or junk
        -- field becomes NULL and a named refusal, never a 22P02 throw
        SELECT x.n,
               CASE WHEN x.e->>'group_buy_product_id' ~ '^[0-9]+$' THEN (x.e->>'group_buy_product_id')::bigint END AS gbp_id,
               CASE WHEN x.e->>'kits_qty' ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN (x.e->>'kits_qty')::numeric END AS kits_n,
               CASE WHEN x.e->>'amount_usd' ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN (x.e->>'amount_usd')::numeric END AS amt_n,
               COALESCE(x.e->>'allow_over', '') = 'true' AS allow_over,
               CASE WHEN x.e->>'confirmed_owed' ~ '^-?[0-9]+(\.[0-9]{1,2})?$' THEN (x.e->>'confirmed_owed')::numeric END AS confirmed_owed
        FROM jsonb_array_elements(COALESCE(NULLIF(p_lines::text, ''), '[]')::jsonb) WITH ORDINALITY AS x(e, n)
      ), inp_sends AS (
        SELECT x.n,
               CASE WHEN x.e->>'wallet_id' ~ '^[0-9]+$' THEN (x.e->>'wallet_id')::bigint END AS wallet_id,
               CASE WHEN x.e->>'amount_usd' ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN (x.e->>'amount_usd')::numeric END AS amt_n,
               NULLIF(btrim(COALESCE(x.e->>'method', '')), '') AS method,
               NULLIF(btrim(COALESCE(x.e->>'tx_ref', '')), '') AS tx_ref
        FROM jsonb_array_elements(COALESCE(NULLIF(p_sends::text, ''), '[]')::jsonb) WITH ORDINALITY AS x(e, n)
      ), inp_freight AS (
        SELECT NULLIF(btrim(p_freight_usd::text), '') AS f_text,
               CASE WHEN btrim(p_freight_usd::text) ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN btrim(p_freight_usd::text)::numeric END AS f_n,
               p_allow_over_freight::text = 'true' AS allow_over,
               CASE WHEN p_confirmed_freight_owed::text ~ '^-?[0-9]+(\.[0-9]{1,2})?$' THEN p_confirmed_freight_owed::text::numeric END AS confirmed
      ), inp_other AS (
        -- Other-items money (1790102400): no product, no kits, no freight
        SELECT NULLIF(btrim(p_other_usd::text), '') AS o_text,
               CASE WHEN btrim(p_other_usd::text) ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN btrim(p_other_usd::text)::numeric END AS o_n,
               p_allow_over_other::text = 'true' AS allow_over,
               CASE WHEN p_confirmed_other_owed::text ~ '^-?[0-9]+(\.[0-9]{1,2})?$' THEN p_confirmed_other_owed::text::numeric END AS confirmed
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
        FROM inp_lines l
        LEFT JOIN group_buy_products gbp
          ON gbp.id = l.gbp_id
         AND gbp.vendor_id = p_vendor_id::bigint
         AND gbp.group_buy_id = p_group_buy_id::bigint
        LEFT JOIN products p ON p.id = gbp.product_id
        LEFT JOIN v_moq_progress m ON m.group_buy_product_id = gbp.id
      ), cur_vendor AS (
        SELECT (
          SELECT vb.freight_demand_usd - vb.freight_paid_usd
          FROM v_vendor_balances vb
          WHERE vb.vendor_id = p_vendor_id::bigint
            AND vb.group_buy_id = p_group_buy_id::bigint
        ) AS freight_remaining,
        (
          SELECT vb.other_owed_usd - vb.other_paid_usd
          FROM v_vendor_balances vb
          WHERE vb.vendor_id = p_vendor_id::bigint
            AND vb.group_buy_id = p_group_buy_id::bigint
        ) AS other_remaining
      ), totals AS (
        SELECT (SELECT COALESCE(SUM(amt_n), 0) FROM inp_lines)
                 + COALESCE((SELECT f_n FROM inp_freight), 0)
                 + COALESCE((SELECT o_n FROM inp_other), 0) AS lines_total,
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
                      AND NOT (COALESCE(f.f_n <= cv.freight_remaining, false)
                               OR COALESCE(f.allow_over AND cv.freight_remaining >= f.confirmed, false))
                   THEN 'exceeds freight still owed (' || COALESCE(cv.freight_remaining::text, '?') || ') — press Record again to confirm the override'
               END
        FROM inp_freight f, cur_vendor cv, totals t
        UNION ALL
        SELECT 'other items',
               CASE
                 WHEN o.o_text IS NOT NULL AND o.o_n IS NULL THEN 'must be a $ amount with at most 2 decimals'
                 WHEN COALESCE(o.o_n, 0) > 0
                      AND NOT (COALESCE(o.o_n <= cv.other_remaining, false)
                               OR COALESCE(o.allow_over AND cv.other_remaining >= o.confirmed, false))
                   THEN 'exceeds Other items still owed (' || COALESCE(cv.other_remaining::text, '?') || ') — press Record again to confirm the override'
               END
        FROM inp_other o, cur_vendor cv
        UNION ALL
        SELECT 'payment',
               CASE
                 WHEN t.line_n = 0 AND COALESCE((SELECT f_n FROM inp_freight), 0) = 0 AND COALESCE((SELECT o_n FROM inp_other), 0) = 0
                   THEN 'needs at least one product line, freight, or Other items'
                 WHEN t.send_n = 0 THEN 'needs at least one send'
                 WHEN t.lines_total <> t.sends_total THEN 'sends total ' || t.sends_total::text || ' does not equal the lines + freight + other total ' || t.lines_total::text
               END
        FROM totals t
      ), refused AS (
        SELECT what, why FROM refusal WHERE why IS NOT NULL
      ), ins_batch AS (
        INSERT INTO vendor_payment_batches (vendor_id, group_buy_id, paid_on, note, created_by)
        SELECT p_vendor_id::bigint, p_group_buy_id::bigint, p_paid_on::date,
               NULLIF(btrim(p_note::text), ''), p_actor::text
        WHERE NOT EXISTS (SELECT 1 FROM refused)
          AND EXISTS (SELECT 1 FROM vendors v WHERE v.id = p_vendor_id::bigint AND v.active)
        RETURNING id, vendor_id, group_buy_id, paid_on, note, created_at
      ), ins_lines AS (
        -- batched lines carry NO wallet/method/ref: the money is on the
        -- sends (CHECK vendor_payments_batch_money_on_sends)
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, batch_id)
        SELECT b.vendor_id, b.group_buy_id, b.paid_on, l.amt_n, NULL, NULL, NULL, b.note, l.kits_n, NULL, l.gbp_id, b.id
        FROM ins_batch b, inp_lines l
        RETURNING vendor_payments.id, vendor_payments.amount_usd, vendor_payments.kits_qty, vendor_payments.group_buy_product_id, vendor_payments.batch_id
      ), ins_freight AS (
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, batch_id)
        SELECT b.vendor_id, b.group_buy_id, b.paid_on, f.f_n, NULL, NULL, NULL, b.note, NULL, f.f_n, NULL, b.id
        FROM ins_batch b, inp_freight f
        WHERE COALESCE(f.f_n, 0) > 0
        RETURNING vendor_payments.id, vendor_payments.amount_usd, vendor_payments.freight_usd, vendor_payments.batch_id
      ), ins_other AS (
        -- the Other-items line: no product, no kits, no freight — neither
        -- ledger moves, only the vendor's money
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, batch_id)
        SELECT b.vendor_id, b.group_buy_id, b.paid_on, o.o_n, NULL, NULL, NULL, b.note, NULL, NULL, NULL, b.id
        FROM ins_batch b, inp_other o
        WHERE COALESCE(o.o_n, 0) > 0
        RETURNING vendor_payments.id, vendor_payments.amount_usd, vendor_payments.batch_id
      ), ins_sends AS (
        INSERT INTO vendor_payment_sends (batch_id, vendor_id, group_buy_id, wallet_id, amount_usd, method, tx_ref)
        SELECT b.id, b.vendor_id, b.group_buy_id, s.wallet_id, s.amt_n, s.method, s.tx_ref
        FROM ins_batch b, inp_sends s
        RETURNING vendor_payment_sends.id, vendor_payment_sends.wallet_id, vendor_payment_sends.amount_usd, vendor_payment_sends.method, vendor_payment_sends.tx_ref
      ), audit_lines AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', il.id::text, 'insert', p_actor::text,
               jsonb_build_object('vendor_id', p_vendor_id::bigint, 'amount_usd', il.amount_usd, 'kits_qty', il.kits_qty,
                                  'freight_usd', NULL, 'group_buy_product_id', il.group_buy_product_id, 'batch_id', il.batch_id,
                                  'over_owed_override', l.allow_over, 'confirmed_owed', l.confirmed_owed,
                                  'owed_at_insert', c.kits_remaining)
        FROM ins_lines il
        JOIN inp_lines l ON l.gbp_id = il.group_buy_product_id
        JOIN cur_lines c ON c.n = l.n
        RETURNING row_pk
      ), audit_freight AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', fr.id::text, 'insert', p_actor::text,
               jsonb_build_object('vendor_id', p_vendor_id::bigint, 'amount_usd', fr.amount_usd, 'kits_qty', NULL,
                                  'freight_usd', fr.freight_usd, 'group_buy_product_id', NULL, 'batch_id', fr.batch_id,
                                  'over_freight_override', f.allow_over, 'confirmed_freight_owed', f.confirmed,
                                  'freight_owed_at_insert', cv.freight_remaining)
        FROM ins_freight fr, inp_freight f, cur_vendor cv
        RETURNING row_pk
      ), audit_other AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', oi.id::text, 'insert', p_actor::text,
               jsonb_build_object('vendor_id', p_vendor_id::bigint, 'amount_usd', oi.amount_usd, 'kits_qty', NULL,
                                  'freight_usd', NULL, 'group_buy_product_id', NULL, 'batch_id', oi.batch_id,
                                  'other_items', true,
                                  'over_other_override', o.allow_over, 'confirmed_other_owed', o.confirmed,
                                  'other_owed_at_insert', cv.other_remaining)
        FROM ins_other oi, inp_other o, cur_vendor cv
        RETURNING row_pk
      ), audit_batch AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payment_batches', b.id::text, 'vendor_payment_batch_recorded', p_actor::text,
               jsonb_build_object('vendor_id', b.vendor_id, 'group_buy_id', b.group_buy_id, 'paid_on', b.paid_on, 'note', b.note,
                                  'lines', (SELECT jsonb_agg(jsonb_build_object('id', id, 'group_buy_product_id', group_buy_product_id, 'kits_qty', kits_qty, 'amount_usd', amount_usd) ORDER BY id) FROM ins_lines),
                                  'freight', (SELECT jsonb_agg(jsonb_build_object('id', id, 'freight_usd', freight_usd)) FROM ins_freight),
                                  'other_items', (SELECT jsonb_agg(jsonb_build_object('id', id, 'amount_usd', amount_usd)) FROM ins_other),
                                  'sends', (SELECT jsonb_agg(jsonb_build_object('id', id, 'wallet_id', wallet_id, 'amount_usd', amount_usd, 'method', method, 'tx_ref', tx_ref) ORDER BY id) FROM ins_sends),
                                  'total_usd', (SELECT lines_total FROM totals))
        FROM ins_batch b
        RETURNING row_pk
      )
      -- exactly one result row: the batch id on success, else NULL with
      -- every refusal named (nothing was written)
      SELECT (SELECT ib.id FROM ins_batch ib),
             (SELECT jsonb_agg(jsonb_build_object('what', rf.what, 'why', rf.why)) FROM refused rf);
END
$fn$;

COMMENT ON FUNCTION record_vendor_payment_batch(text, text, text, text, text, text, text, text, text, text, text, text, text) IS
  'Records one vendor payment batch (product lines, freight, Other items, sends) all-or-nothing under advisory lock 42002 taken in its own statement (1790102200, Other items 1790102400). Returns (batch_id, refused); batch_id NULL means nothing was written and refused names why.';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102400_other_items_writers_and_payment.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102400_other_items_writers_and_payment.sql');
