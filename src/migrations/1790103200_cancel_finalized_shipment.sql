-- Cancel a finalized shipment that was recorded shipped by mistake
-- (Ian, 2026-11-01, order 2026-138: "accidentally marked shipped. I need
-- the label refunded and its status reset" … "refunding on shippo takes
-- forever. whatever the option it needs to not have to wait for the
-- shippo refund"). Until now the only way to undo a finalized box was the
-- label refund, which voids the row only when Shippo reports SUCCESS —
-- days for a carrier refund. The order sat on the Shipped tab, its units
-- out of remaining-to-pack and out of inventory, the whole time.
--
-- A cancel separates the two facts the refund conflated:
--  * DID THIS BOX SHIP? No — settled HERE, at once: its recorded lines are
--    removed (the "Fix items → Remove" end state, every line at once, under
--    one lock), so the units return to remaining-to-pack and to the
--    ship-from inventory immediately, and the order re-enters Ready to
--    pack. What the box held is kept on the row (cancelled_items) and in
--    the audit row.
--  * IS THE LABEL MONEY BACK? Still the Shippo refund (refund_status),
--    untouched: requested, re-checked and settled exactly as before. The
--    label cost keeps counting until it is refunded.
--
-- A cancelled box keeps its row (label, tracking, Shippo transaction) for
-- the refund and the record, but it is no longer a shipment: the queue,
-- the order list, the delivery poll and every push surface skip it
-- (cancelled_at IS NULL in those readers), and markShipmentPushed refuses
-- it. The ordering-app side is reset by the client
-- (resetVoidedShipmentUpstream, src/lib/pushShipment.ts), stamped in
-- upstream_reset_at; until then the Fulfillment row says so instead of
-- inviting a "Record here" adoption of the very shipment that was
-- cancelled.
--
-- Guards (all post-lock): 42001(order) -> shipments row FOR UPDATE;
-- finalized, not refund-voided, not already cancelled; not an adopted
-- record of an ordering-app hand mark (carrier 'upstream' — cancelling
-- it here would only see the auto-adopt pass record the same mark again;
-- that is corrected in the ordering app first); not a box the carrier has
-- reported moving, delivered, returned or failed, nor one the operator
-- recorded delivered or reshipped (it went out — a return, not a cancel);
-- not while a push of the box holds a fresh claim; reason and actor
-- required.
-- Refusals return zero rows. push_epoch is bumped so a push of this box
-- already in flight cannot stamp it. Audited 'shipment_cancelled'.
--
-- For every writer: a cancelled shipment takes no shipment_items (the
-- trigger below), and its cancel record never changes or clears.

-- push_claimed_at: a push of this box is in flight (claimShipmentPush,
-- taken under the 42001 order lock before the push writes anything
-- upstream, renewed right before its PUT, cleared by the stamp or a
-- release). A cancel refuses while a claim is fresh, and a push cannot
-- claim a cancelled box — so a push planned before a cancel can never
-- land after that cancel's reset (Codex, 2026-11-01). A claim older than
-- 10 minutes is a dead tab's and no longer counts.
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS push_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_items jsonb,
  ADD COLUMN IF NOT EXISTS upstream_reset_at timestamptz;

DO $c$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_cancel_shape') THEN
    ALTER TABLE shipments ADD CONSTRAINT shipments_cancel_shape CHECK (
      cancelled_at IS NULL
      OR (finalized_at IS NOT NULL
          AND cancelled_by IS NOT NULL AND btrim(cancelled_by) <> ''
          AND cancel_reason IS NOT NULL AND btrim(cancel_reason) <> ''
          AND cancelled_items IS NOT NULL AND jsonb_typeof(cancelled_items) = 'array'));
  END IF;
END $c$;

-- a cancelled box is empty for every writer: no line may be added to it,
-- moved onto it, or re-quantified on it
CREATE OR REPLACE FUNCTION shipment_items_refuse_cancelled() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM shipments s WHERE s.id = NEW.shipment_id AND s.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'shipment % was cancelled (recorded shipped by mistake) — it takes no items; ship the units in a new box', NEW.shipment_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS shipment_items_refuse_cancelled ON shipment_items;
CREATE TRIGGER shipment_items_refuse_cancelled
  BEFORE INSERT OR UPDATE ON shipment_items
  FOR EACH ROW EXECUTE FUNCTION shipment_items_refuse_cancelled();

-- the cancel record is written once, by cancel_finalized_shipment, and
-- never edited or cleared; upstream_reset_at only on a voided box
CREATE OR REPLACE FUNCTION shipments_cancel_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.cancelled_at IS NOT NULL AND (
       NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
    OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by
    OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason
    OR NEW.cancelled_items IS DISTINCT FROM OLD.cancelled_items) THEN
    RAISE EXCEPTION 'shipment % cancel record is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.upstream_reset_at IS NOT NULL AND NEW.upstream_reset_at IS DISTINCT FROM OLD.upstream_reset_at THEN
    RAISE EXCEPTION 'shipment % ordering-app reset stamp is immutable', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL
     AND current_setting('snd.cancel_shipment', true) IS DISTINCT FROM OLD.id::text THEN
    RAISE EXCEPTION 'shipment % may be cancelled only through cancel_finalized_shipment()', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.upstream_reset_at IS NOT NULL AND OLD.upstream_reset_at IS NULL
     AND NEW.cancelled_at IS NULL AND COALESCE(NEW.refund_status, '') <> 'SUCCESS' THEN
    RAISE EXCEPTION 'shipment % is live — only a cancelled or refunded box is reset in the ordering app', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS shipments_cancel_immutable ON shipments;
CREATE TRIGGER shipments_cancel_immutable
  BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION shipments_cancel_immutable();

CREATE OR REPLACE FUNCTION cancel_finalized_shipment(
  p_shipment_id bigint,
  p_reason text,
  p_actor text
) RETURNS TABLE (
  o_shipment_id bigint,
  o_order_id bigint,
  o_items jsonb,
  o_was_pushed boolean
) LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_order_id bigint;
  v_row shipments%ROWTYPE;
  v_items jsonb;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' OR p_actor IS NULL OR btrim(p_actor) = '' THEN
    RETURN;
  END IF;

  SELECT s.order_id INTO v_order_id FROM shipments s WHERE s.id = p_shipment_id;
  IF v_order_id IS NULL THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(42001, v_order_id::int);

  SELECT s.* INTO v_row
  FROM shipments s
  WHERE s.id = p_shipment_id
    AND s.finalized_at IS NOT NULL
    AND COALESCE(s.refund_status, '') <> 'SUCCESS'
    AND s.cancelled_at IS NULL
    AND COALESCE(s.carrier, '') <> 'upstream'
    -- the carrier has had it, or the operator recorded it delivered /
    -- reshipped: it went out, so it is a return, not a cancel
    AND COALESCE(s.tracking_status, '') NOT IN ('TRANSIT', 'DELIVERED', 'RETURNED', 'FAILURE')
    AND s.status NOT IN ('delivered', 'reshipped')
    -- a push of this box is in flight: it could land after the reset
    AND (s.push_claimed_at IS NULL OR s.push_claimed_at < now() - interval '10 minutes')
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- what the box recorded, with the ordering-app product id in its
  -- campaign (the reset clears ship dates by it)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'order_item_id', si.order_item_id,
           'qty', si.qty,
           'sku_code', p.sku_code,
           'product_id', p.id,
           'product_external_id', cpl.external_id) ORDER BY p.sku_code), '[]'::jsonb)
    INTO v_items
  FROM shipment_items si
  JOIN order_items oi ON oi.id = si.order_item_id
  JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
  JOIN products p ON p.id = gbp.product_id
  LEFT JOIN campaign_product_links cpl
    ON cpl.group_buy_id = gbp.group_buy_id AND cpl.product_id = p.id
  WHERE si.shipment_id = p_shipment_id;

  DELETE FROM shipment_items si WHERE si.shipment_id = p_shipment_id;

  PERFORM set_config('snd.cancel_shipment', p_shipment_id::text, true);
  UPDATE shipments s
  SET cancelled_at = now(),
      cancelled_by = btrim(p_actor),
      cancel_reason = btrim(p_reason),
      cancelled_items = v_items,
      push_epoch = s.push_epoch + 1
  WHERE s.id = p_shipment_id;
  PERFORM set_config('snd.cancel_shipment', '', true);

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
  VALUES (
    'shipments', p_shipment_id::text, 'shipment_cancelled', btrim(p_actor),
    jsonb_build_object('order_id', v_order_id, 'items', v_items, 'status', v_row.status,
                       'carrier', v_row.carrier, 'tracking_number', v_row.tracking_number,
                       'shippo_transaction_id', v_row.shippo_transaction_id,
                       'refund_status', v_row.refund_status, 'label_cost_usd', v_row.label_cost_usd,
                       'finalized_at', v_row.finalized_at, 'b44_pushed_at', v_row.b44_pushed_at),
    jsonb_build_object('order_id', v_order_id, 'reason', btrim(p_reason))
  );

  RETURN QUERY SELECT p_shipment_id, v_order_id, v_items, v_row.b44_pushed_at IS NOT NULL;
END;
$fn$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790103200_cancel_finalized_shipment.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790103200_cancel_finalized_shipment.sql');
