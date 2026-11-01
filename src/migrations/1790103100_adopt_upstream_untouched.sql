-- adopt_upstream_shipment_untouched(): the auto-adopt pass's write
-- (src/lib/autoAdopt.ts). The Adopt button's adopt_upstream_shipment()
-- proves qty <= remaining under the order lock — enough for an operator
-- who sees the order. The unattended pass has a stricter rule: it records
-- a hand mark from the ordering app ONLY on a line with NOTHING recorded
-- here (no box, no draft, no adopted row), and that rule must hold AT
-- WRITE TIME under the lock, not just when the run planned it — a second
-- run reading the same mark, a concurrent run, or a draft opened between
-- the pull and the write must all refuse (Codex, 2026-11-01: a partial
-- hand mark could otherwise be adopted again on every run, since
-- "remaining" stays positive). Zero rows = refused; the wrapped fn's
-- own guards (campaign binding, active order, dates, dupes, qty <=
-- remaining) still apply, and its audit row is the record.
CREATE OR REPLACE FUNCTION adopt_upstream_shipment_untouched(
  p_order_id bigint,
  p_group_buy_id bigint,
  p_items jsonb,                   -- [{order_item_id, qty}] with qty as a string
  p_shipped_date text,             -- 'YYYY-MM-DD' upstream ship date
  p_note text,
  p_actor text
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_n int;
  v_untouched int;
BEGIN
  -- the same lock the wrapped fn takes (re-entrant within this
  -- transaction): the zero-attribution proof and the insert are one
  -- critical section with every other shipment write on the order
  PERFORM pg_advisory_xact_lock(42001, p_order_id::int);

  SELECT count(*) INTO v_n FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 THEN RETURN; END IF;

  -- every named line must be this order's, packed-by-us, live, and carry
  -- ZERO attribution from any non-voided shipment — drafts and adopted
  -- rows included, finalized or not
  SELECT count(*) INTO v_untouched
  FROM jsonb_array_elements(p_items) x
  JOIN order_items oi
    ON oi.id = (x->>'order_item_id')::bigint
   AND oi.order_id = p_order_id
   AND NOT oi.direct_ship
   AND oi.removed_at IS NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id
    WHERE si.order_item_id = oi.id
      AND COALESCE(sh.refund_status, '') <> 'SUCCESS');
  IF v_untouched <> v_n THEN RETURN; END IF;

  RETURN QUERY
    SELECT a.id FROM adopt_upstream_shipment(p_order_id, p_group_buy_id, p_items, p_shipped_date, p_note, p_actor) a;
END
$fn$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103100_adopt_upstream_untouched.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103100_adopt_upstream_untouched.sql');
