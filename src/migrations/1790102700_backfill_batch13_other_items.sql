-- Data repair: batch 13's lump Other-items row is re-attributed to the
-- three items it paid for.
--
-- Batch 13 (CHANGSHA-MIA, Surprise-Last Chance, paid 2026-10-25) was
-- recorded before 1790102600: its $724 Other-items money is ONE row
-- (vendor_payments 58) whose note names what it was for — "other items:
-- PE 22 ×2, Aicar 50 ×2, NJ500 ×20" — exactly adjustments 69 ($54), 70
-- ($70) and 71 ($600), which sum to $724. Without attribution those three
-- items read as owed on the Vendors page (Ian, 2026-10-27).
--
-- Row 58 becomes three rows in the same batch, same date, same note, same
-- recording time, one per item, attributed. Nothing about the money
-- changes: the batch still totals $724 against its sends (the deferred
-- balance trigger re-checks at commit), the vendor's paid and Other-items
-- paid figures are unchanged, the rail cards read the sends. Every
-- precondition is checked and the block raises (nothing changed) if the
-- data is not exactly as described. Audited with the old row and the new
-- rows.
--
-- Run only on the owner's say-so.
--
-- Serialized with the batch recorder (Codex review, 2026-10-27): the
-- block takes the same per-vendor+campaign advisory lock 42002 that
-- record_vendor_payment_batch takes, in a statement of its own BEFORE
-- the guards, so a payment attributed to one of these items cannot be
-- recorded between the "no attributed rows" check and the inserts.

DO $do$
DECLARE
  v_old vendor_payments%ROWTYPE;
  v_new jsonb;
  v_vendor bigint;
  v_gb bigint;
BEGIN
  SELECT vp.vendor_id, vp.group_buy_id INTO v_vendor, v_gb FROM vendor_payments vp WHERE vp.id = 58;
  IF v_vendor IS NULL THEN
    RAISE EXCEPTION 'vendor_payments 58 does not exist — nothing changed';
  END IF;
  PERFORM pg_advisory_xact_lock(42002, hashtext(v_vendor::text || ':' || v_gb::text));
  -- every read below happens under the lock
  SELECT * INTO v_old FROM vendor_payments WHERE id = 58;
  IF v_old.id IS NULL
     OR v_old.batch_id IS DISTINCT FROM 13
     OR v_old.amount_usd <> 724.00
     OR v_old.group_buy_product_id IS NOT NULL
     OR v_old.kits_qty IS NOT NULL
     OR v_old.freight_usd IS NOT NULL
     OR v_old.admin_adjustment_id IS NOT NULL
     OR v_old.wallet_id IS NOT NULL THEN
    RAISE EXCEPTION 'vendor_payments 58 is not batch 13''s unattributed $724 Other-items row — nothing changed';
  END IF;
  IF (SELECT count(*) FROM admin_adjustments a
      WHERE a.id IN (69, 70, 71)
        AND a.vendor_id = v_old.vendor_id
        AND a.group_buy_id = v_old.group_buy_id
        AND a.group_buy_product_id IS NULL
        AND a.expected_usd = CASE a.id WHEN 69 THEN 54.00 WHEN 70 THEN 70.00 ELSE 600.00 END
        AND a.other_name = CASE a.id WHEN 69 THEN 'PE 22' WHEN 70 THEN 'Aicar 50' ELSE 'NJ500' END) <> 3 THEN
    RAISE EXCEPTION 'adjustments 69/70/71 are not PE 22 $54 / Aicar 50 $70 / NJ500 $600 on this vendor and campaign — nothing changed';
  END IF;
  IF EXISTS (SELECT 1 FROM vendor_payments vp WHERE vp.admin_adjustment_id IN (69, 70, 71)) THEN
    RAISE EXCEPTION 'adjustments 69/70/71 already have attributed payment rows — nothing changed';
  END IF;

  WITH ins AS (
    INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note,
                                 kits_qty, freight_usd, group_buy_product_id, batch_id, admin_adjustment_id, created_at)
    SELECT v_old.vendor_id, v_old.group_buy_id, v_old.paid_on, x.amt, NULL, NULL, NULL, v_old.note,
           NULL, NULL, NULL, v_old.batch_id, x.adj, v_old.created_at
    FROM (VALUES (69::bigint, 54.00::numeric), (70::bigint, 70.00::numeric), (71::bigint, 600.00::numeric)) AS x(adj, amt)
    RETURNING vendor_payments.*
  )
  SELECT jsonb_agg(to_jsonb(ins.*) ORDER BY ins.id) INTO v_new FROM ins;

  DELETE FROM vendor_payments WHERE id = v_old.id;

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES ('vendor_payments', v_old.id::text, 'other_items_reattributed', 'migration 1790102700',
          to_jsonb(v_old),
          jsonb_build_object('rows', v_new, 'reason', 'batch 13 lump Other-items row split per item (PE 22, Aicar 50, NJ500) — 1790102600'));
END
$do$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790102700_backfill_batch13_other_items.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790102700_backfill_batch13_other_items.sql');
