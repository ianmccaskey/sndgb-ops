-- Other-items money is attributed to the ITEM it paid for.
--
-- Ian, 2026-10-27, looking at Surprise-Last Chance on the Vendors page:
-- "it looks like we still owe for PE 22, AICAR, and NJ500 when we
-- submitted payment for those Other items the other day." The payment
-- (batch 13, $724 on 2026-10-25) was recorded, and the vendor row showed
-- it ($724 of $23,634 Other items paid) — but an Other-items payment line
-- carried no item attribution (1790102400 recorded ONE lump row per batch,
-- naming the picked items only in the note), so every item row read as
-- owed whatever had been paid. Two Other rows can share a name (R30 ×20
-- and R30 ×100 both sit on this vendor), so the note can never be the
-- attribution.
--
-- An Other-items payment line now names its adjustment:
--   * vendor_payments.admin_adjustment_id — the Other adjustment the money
--     paid for. A composite FK (adjustment id, vendor, campaign) keeps it
--     THIS vendor's adjustment in THIS campaign; a campaign-product
--     adjustment has vendor_id NULL so it can never be named. A CHECK
--     keeps an attributed row an Other-items row (no product, no kits, no
--     freight). The lump "Other items $" line stays legal and unattributed.
--   * record_vendor_payment_batch takes p_other_lines
--     [{admin_adjustment_id, amount_usd}] beside the lump: one
--     vendor_payments row per item, refused when the item is not the
--     vendor's, is listed twice, or is paid beyond what it still owes
--     (confirm-then-anchor like kits/freight, anchored on the vendor's
--     Other items remaining, which the lump + lines total is still capped
--     against). The old signature is dropped.
--   * v_vendor_balances is unchanged: other_paid_usd still sums every
--     Other-items row, attributed or not. Per-item paid-ness is read by
--     listVendorOtherItems (SUM over the attributed rows); the difference
--     between the vendor's other_paid_usd and the items' sum is money paid
--     as a lump, shown as such.
--   * deleteAdjustment refuses an Other item that has attributed money
--     (the FK would refuse it too, less clearly): remove the payment batch
--     first if the item really goes.
--
-- Batch 13's existing lump row is re-attributed by 1790102700 (a data
-- repair, run on the owner's say-so), not here.

ALTER TABLE admin_adjustments
  ADD CONSTRAINT admin_adjustments_id_vendor_campaign_uq UNIQUE (id, vendor_id, group_buy_id);

ALTER TABLE vendor_payments
  ADD COLUMN admin_adjustment_id BIGINT REFERENCES admin_adjustments(id),
  -- the named adjustment is THIS vendor's, in THIS campaign (an Other row;
  -- product rows carry vendor_id NULL and so never match)
  ADD CONSTRAINT vendor_payments_other_item_fk
    FOREIGN KEY (admin_adjustment_id, vendor_id, group_buy_id)
    REFERENCES admin_adjustments (id, vendor_id, group_buy_id),
  -- an attributed row is an Other-items row: neither ledger moves
  ADD CONSTRAINT vendor_payments_other_item_shape
    CHECK (admin_adjustment_id IS NULL
           OR (group_buy_product_id IS NULL AND kits_qty IS NULL AND freight_usd IS NULL));
CREATE INDEX vendor_payments_other_item_idx ON vendor_payments (admin_adjustment_id)
  WHERE admin_adjustment_id IS NOT NULL;

COMMENT ON COLUMN vendor_payments.admin_adjustment_id IS
  'The Other-item adjustment this Other-items payment line paid for (1790102600). NULL on a lump Other-items line, on product lines and on freight.';

-- ---- the batch recorder takes Other-item lines ---------------------------

DROP FUNCTION IF EXISTS record_vendor_payment_batch(text, text, text, text, text, text, text, text, text, text, text, text, text);

CREATE OR REPLACE FUNCTION record_vendor_payment_batch(
  p_vendor_id text, p_group_buy_id text, p_paid_on text, p_note text,
  p_lines text, p_freight_usd text, p_allow_over_freight text, p_confirmed_freight_owed text,
  p_sends text, p_actor text,
  p_other_usd text, p_allow_over_other text, p_confirmed_other_owed text,
  -- DEFAULT so the 13-argument call the live app makes until the next
  -- deploy still resolves (to this function, with no item lines); the
  -- 13-parameter function itself is dropped
  p_other_lines text DEFAULT ''
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
        -- the LUMP Other-items money (1790102400): no product, no kits, no
        -- freight, no item. Its override flag and anchor cover the item
        -- lines too (one vendor-level confirmation in the form)
        SELECT NULLIF(btrim(p_other_usd::text), '') AS o_text,
               CASE WHEN btrim(p_other_usd::text) ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN btrim(p_other_usd::text)::numeric END AS o_n,
               p_allow_over_other::text = 'true' AS allow_over,
               CASE WHEN p_confirmed_other_owed::text ~ '^-?[0-9]+(\.[0-9]{1,2})?$' THEN p_confirmed_other_owed::text::numeric END AS confirmed
      ), inp_other_lines AS (
        -- Other-item lines (1790102600): money for ONE named Other adjustment
        SELECT x.n,
               CASE WHEN x.e->>'admin_adjustment_id' ~ '^[0-9]+$' THEN (x.e->>'admin_adjustment_id')::bigint END AS adj_id,
               CASE WHEN x.e->>'amount_usd' ~ '^[0-9]+(\.[0-9]{1,2})?$' THEN (x.e->>'amount_usd')::numeric END AS amt_n
        FROM jsonb_array_elements(COALESCE(NULLIF(p_other_lines::text, ''), '[]')::jsonb) WITH ORDINALITY AS x(e, n)
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
      ), cur_other_lines AS (
        -- what each named item still owes, read AFTER the lock: its cost
        -- minus every payment row already attributed to it
        SELECT l.n, l.adj_id, a.other_name,
               a.id IS NOT NULL AS item_ok,
               a.expected_usd - COALESCE((
                 SELECT SUM(vp2.amount_usd)
                 FROM vendor_payments vp2
                 WHERE vp2.admin_adjustment_id = a.id
               ), 0) AS item_remaining
        FROM inp_other_lines l
        LEFT JOIN admin_adjustments a
          ON a.id = l.adj_id
         AND a.group_buy_product_id IS NULL
         AND a.vendor_id = p_vendor_id::bigint
         AND a.group_buy_id = p_group_buy_id::bigint
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
                 + COALESCE((SELECT o_n FROM inp_other), 0)
                 + (SELECT COALESCE(SUM(amt_n), 0) FROM inp_other_lines) AS lines_total,
               (SELECT COALESCE(SUM(amt_n), 0) FROM inp_sends) AS sends_total,
               (SELECT count(*) FROM inp_lines) AS line_n,
               (SELECT count(*) FROM inp_sends) AS send_n,
               (SELECT count(*) FROM inp_other_lines) AS other_line_n,
               -- every Other-items dollar in this batch: lump + item lines,
               -- capped together against the vendor's Other items remaining
               COALESCE((SELECT o_n FROM inp_other), 0)
                 + (SELECT COALESCE(SUM(amt_n), 0) FROM inp_other_lines) AS other_total
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
        SELECT 'other item ' || l.n || CASE WHEN c.other_name IS NOT NULL THEN ' (' || c.other_name || ')' ELSE '' END,
               CASE
                 WHEN NOT c.item_ok THEN 'not this vendor''s Other item in this campaign'
                 WHEN l.amt_n IS NULL OR l.amt_n <= 0 THEN 'amount must be a positive $ amount with at most 2 decimals'
                 WHEN (SELECT count(*) FROM inp_other_lines l2 WHERE l2.adj_id = l.adj_id) > 1 THEN 'listed twice — one line per item'
                 -- beyond what THIS item still owes: allowed only under the
                 -- vendor-level Other-items confirmation, anchored like the
                 -- lump (a stale anchor refuses rather than widening)
                 WHEN NOT (COALESCE(l.amt_n <= c.item_remaining, false)
                           OR COALESCE(o.allow_over AND cv.other_remaining >= o.confirmed, false))
                   THEN 'exceeds what this item still owes (' || COALESCE(c.item_remaining::text, '?') || ') — press Record again to confirm the override'
               END
        FROM inp_other_lines l
        JOIN cur_other_lines c ON c.n = l.n, inp_other o, cur_vendor cv
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
                 WHEN t.other_total > 0
                      AND NOT (COALESCE(t.other_total <= cv.other_remaining, false)
                               OR COALESCE(o.allow_over AND cv.other_remaining >= o.confirmed, false))
                   THEN 'exceeds Other items still owed (' || COALESCE(cv.other_remaining::text, '?') || ') — press Record again to confirm the override'
               END
        FROM inp_other o, cur_vendor cv, totals t
        UNION ALL
        SELECT 'payment',
               CASE
                 WHEN t.line_n = 0 AND t.other_line_n = 0 AND COALESCE((SELECT f_n FROM inp_freight), 0) = 0 AND COALESCE((SELECT o_n FROM inp_other), 0) = 0
                   THEN 'needs at least one product line, Other item, freight, or Other items money'
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
        -- the lump Other-items line: no product, no kits, no freight, no
        -- item — neither ledger moves, only the vendor's money
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, batch_id)
        SELECT b.vendor_id, b.group_buy_id, b.paid_on, o.o_n, NULL, NULL, NULL, b.note, NULL, NULL, NULL, b.id
        FROM ins_batch b, inp_other o
        WHERE COALESCE(o.o_n, 0) > 0
        RETURNING vendor_payments.id, vendor_payments.amount_usd, vendor_payments.batch_id
      ), ins_other_lines AS (
        -- one row per Other item, attributed to it
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd, group_buy_product_id, batch_id, admin_adjustment_id)
        SELECT b.vendor_id, b.group_buy_id, b.paid_on, l.amt_n, NULL, NULL, NULL, b.note, NULL, NULL, NULL, b.id, l.adj_id
        FROM ins_batch b, inp_other_lines l
        RETURNING vendor_payments.id, vendor_payments.amount_usd, vendor_payments.batch_id, vendor_payments.admin_adjustment_id
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
                                  'other_items', true, 'admin_adjustment_id', NULL,
                                  'over_other_override', o.allow_over, 'confirmed_other_owed', o.confirmed,
                                  'other_owed_at_insert', cv.other_remaining)
        FROM ins_other oi, inp_other o, cur_vendor cv
        RETURNING row_pk
      ), audit_other_lines AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payments', ol.id::text, 'insert', p_actor::text,
               jsonb_build_object('vendor_id', p_vendor_id::bigint, 'amount_usd', ol.amount_usd, 'kits_qty', NULL,
                                  'freight_usd', NULL, 'group_buy_product_id', NULL, 'batch_id', ol.batch_id,
                                  'other_items', true, 'admin_adjustment_id', ol.admin_adjustment_id,
                                  'over_other_override', o.allow_over, 'confirmed_other_owed', o.confirmed,
                                  'other_owed_at_insert', cv.other_remaining,
                                  'item_owed_at_insert', c.item_remaining)
        FROM ins_other_lines ol
        JOIN cur_other_lines c ON c.adj_id = ol.admin_adjustment_id, inp_other o, cur_vendor cv
        RETURNING row_pk
      ), audit_batch AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'vendor_payment_batches', b.id::text, 'vendor_payment_batch_recorded', p_actor::text,
               jsonb_build_object('vendor_id', b.vendor_id, 'group_buy_id', b.group_buy_id, 'paid_on', b.paid_on, 'note', b.note,
                                  'lines', (SELECT jsonb_agg(jsonb_build_object('id', id, 'group_buy_product_id', group_buy_product_id, 'kits_qty', kits_qty, 'amount_usd', amount_usd) ORDER BY id) FROM ins_lines),
                                  'freight', (SELECT jsonb_agg(jsonb_build_object('id', id, 'freight_usd', freight_usd)) FROM ins_freight),
                                  'other_items', (SELECT jsonb_agg(j ORDER BY (j->>'id')::bigint) FROM (
                                      SELECT jsonb_build_object('id', id, 'amount_usd', amount_usd, 'admin_adjustment_id', NULL) AS j FROM ins_other
                                      UNION ALL
                                      SELECT jsonb_build_object('id', id, 'amount_usd', amount_usd, 'admin_adjustment_id', admin_adjustment_id) FROM ins_other_lines
                                    ) u),
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

COMMENT ON FUNCTION record_vendor_payment_batch(text, text, text, text, text, text, text, text, text, text, text, text, text, text) IS
  'Records one vendor payment batch (product lines, freight, Other items lump + per-item lines, sends) all-or-nothing under advisory lock 42002 taken in its own statement (1790102200, Other items 1790102400, item attribution 1790102600). Returns (batch_id, refused); batch_id NULL means nothing was written and refused names why.';

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102600_other_item_payment_attribution.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102600_other_item_payment_attribution.sql');
