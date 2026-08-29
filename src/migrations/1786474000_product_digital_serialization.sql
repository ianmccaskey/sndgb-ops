-- Review hardening on 1786473900, two findings:
--
-- (1) The digital toggle and shipment creation raced: the toggle was a
--     single-statement SQL action, and a single statement that WAITS on a
--     lock still reads with its ORIGINAL snapshot (EvalPlanQual re-checks
--     only the target row) — so a toggle blocking behind an in-flight
--     draft could commit digital=true WITHOUT seeing the draft's fresh
--     attribution. Serialization is now a shared per-product advisory
--     lock, namespace 42007, key 'prod_digital_' || product_id:
--       * set_product_digital() (NEW plpgsql fn — statements get fresh
--         snapshots) takes the lock, THEN checks attribution, then flips;
--       * create_shipment_draft / create_manual_shipment take the same
--         locks for every DISTINCT product of the order's lines, ORDERED
--         by product id (deadlock-safe), before validating — an in-flight
--         flip commits first and the validation sees the flag; a flip
--         arriving second waits and sees the new attribution.
--     Lock order overall: 42001(order) -> 42007(products, ordered) ->
--     42006(tracking, manual fn only); the toggle takes ONLY 42007 — no
--     cycle exists.
--
-- (2) Verification that the 1786473900 COA backfill stranded nothing:
--     asserted below AT EXECUTION TIME (raises if any digital product
--     holds non-voided shipment attribution). Verified live before this
--     migration ran: shipment_items held ZERO rows total.
DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
    JOIN order_items oi ON oi.id = si.order_item_id
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    JOIN products p ON p.id = g.product_id
    WHERE p.digital
  ) THEN
    RAISE EXCEPTION 'digital products hold live shipment attribution - repair before applying';
  END IF;
END
$chk$;

CREATE OR REPLACE FUNCTION set_product_digital(
  p_product_id bigint,
  p_digital boolean,
  p_expected_digital boolean,
  p_actor text
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  -- serialize with shipment creation on this product (see header)
  PERFORM pg_advisory_xact_lock(hashtextextended('prod_digital_' || p_product_id::text, 42007));

  -- CAS on the value the editor saw
  PERFORM 1 FROM products p
  WHERE p.id = p_product_id AND p.digital = p_expected_digital
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- flipping TO digital refuses while any non-voided shipment holds
  -- attributed quantity of this product — a box already physically
  -- contains it; void/refund those shipments first. (Lines with merely
  -- REMAINING work don't block: hiding those is what the flag is for.)
  IF p_digital AND EXISTS (
    SELECT 1 FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
    JOIN order_items oi ON oi.id = si.order_item_id
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    WHERE g.product_id = p_product_id
  ) THEN RETURN; END IF;

  UPDATE products p SET digital = p_digital WHERE p.id = p_product_id;

  INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
  SELECT 'products', p.id::text, 'product_digital_set', p_actor,
         jsonb_build_object('digital', p_expected_digital),
         jsonb_build_object('sku_code', p.sku_code, 'digital', p.digital)
  FROM products p WHERE p.id = p_product_id;

  RETURN QUERY SELECT p_product_id::text;
END
$fn$;

-- create_shipment_draft re-created with the ordered 42007 product locks
-- (full text, exactly as executed live; only the lock loop is new vs
-- 1786473900)
CREATE OR REPLACE FUNCTION create_shipment_draft(
  p_order_id bigint,
  p_group_buy_id bigint,
  p_ship_from_address_id bigint,
  p_expected_from jsonb,
  p_expected_to jsonb,
  p_parcel jsonb,
  p_carrier text,
  p_servicelevel text,
  p_rate_amount text,
  p_rate_currency text,
  p_shippo_rate_id text,
  p_items jsonb,
  p_box text,
  p_note text,
  p_actor text
) RETURNS TABLE (id text, claimed_at text)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_order orders%ROWTYPE;
  v_addr receive_addresses%ROWTYPE;
  v_n int;
  v_distinct int;
  v_all_valid boolean;
  v_id bigint;
  v_claimed timestamptz;
  v_pid bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(42001, p_order_id::int);

  SELECT * INTO v_order FROM orders o
  WHERE o.id = p_order_id
    AND o.group_buy_id = p_group_buy_id
    AND o.status NOT IN ('cancelled', 'refunded')
    AND NOT o.hold_shipping
    AND COALESCE(o.address_line1, '') <> ''
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- serialize with set_product_digital: every product on this order's
  -- lines, ordered by id (deadlock-safe) — see 1786474000 header
  FOR v_pid IN
    SELECT DISTINCT g.product_id FROM order_items oi
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    WHERE oi.order_id = p_order_id
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('prod_digital_' || v_pid::text, 42007));
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM v_order_reconciliation r
    WHERE r.order_id = p_order_id
      AND r.recon_status IN ('matched', 'over')
      AND r.pending_payment_count = 0
  ) THEN RETURN; END IF;

  IF jsonb_build_object('street1', COALESCE(v_order.address_line1, ''),
                        'street2', COALESCE(v_order.address_line2, ''),
                        'city',    COALESCE(v_order.city, ''),
                        'state',   COALESCE(v_order.state_code, ''),
                        'zip',     COALESCE(v_order.postal_code, ''))
     IS DISTINCT FROM p_expected_to THEN RETURN; END IF;

  SELECT * INTO v_addr FROM receive_addresses ra
  WHERE ra.id = p_ship_from_address_id AND ra.active
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                        'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                        'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
     IS DISTINCT FROM p_expected_from THEN RETURN; END IF;

  IF NULLIF(p_shippo_rate_id, '') IS NULL THEN RETURN; END IF;

  SELECT count(*), count(DISTINCT x->>'order_item_id')
  INTO v_n, v_distinct
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR v_distinct <> v_n THEN RETURN; END IF;

  PERFORM 1 FROM order_items oi WHERE oi.order_id = p_order_id FOR UPDATE;

  SELECT bool_and(
           x->>'qty' ~ '^[0-9]+(\.[0-9]{1,2})?$'
           AND (x->>'qty')::numeric > 0
           AND oi.id IS NOT NULL
           AND (x->>'qty')::numeric
               <= COALESCE(oi.qty_override, oi.qty) - COALESCE(att.attributed, 0))
  INTO v_all_valid
  FROM jsonb_array_elements(p_items) x
  LEFT JOIN order_items oi
    ON oi.id = (x->>'order_item_id')::bigint
   AND oi.order_id = p_order_id
   AND NOT oi.direct_ship
   AND oi.removed_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM group_buy_products g
     JOIN products p ON p.id = g.product_id
     WHERE g.id = oi.group_buy_product_id AND p.digital)
  LEFT JOIN LATERAL (
    SELECT sum(si.qty) AS attributed
    FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id
    WHERE si.order_item_id = oi.id
      AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
  ) att ON true;
  IF NOT COALESCE(v_all_valid, false) THEN RETURN; END IF;

  INSERT INTO shipments (order_id, ship_from_address_id, from_label, from_address, destination, parcel,
                         carrier, servicelevel, rate_amount, rate_currency, shippo_rate_id,
                         box, note, status, label_cost_usd, created_by, purchase_started_at)
  VALUES (p_order_id, v_addr.id, v_addr.label,
          jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                             'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                             'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email),
          jsonb_build_object('name', COALESCE(NULLIF(v_order.contact_name, ''), 'Customer'),
                             'street1', COALESCE(v_order.address_line1, ''),
                             'street2', COALESCE(v_order.address_line2, ''),
                             'city', COALESCE(v_order.city, ''),
                             'state', COALESCE(v_order.state_code, ''),
                             'zip', COALESCE(v_order.postal_code, ''),
                             'country', 'US',
                             'phone', COALESCE(v_order.contact_phone, ''),
                             'email', COALESCE(v_order.contact_email::text, '')),
          p_parcel,
          NULLIF(p_carrier, ''), NULLIF(p_servicelevel, ''), NULLIF(p_rate_amount, '')::numeric,
          NULLIF(p_rate_currency, ''), NULLIF(p_shippo_rate_id, ''),
          NULLIF(TRIM(COALESCE(p_box, '')), ''), NULLIF(TRIM(COALESCE(p_note, '')), ''),
          'pending', 0, p_actor, now())
  RETURNING shipments.id, shipments.purchase_started_at INTO v_id, v_claimed;

  INSERT INTO shipment_items (shipment_id, order_item_id, qty)
  SELECT v_id, (x->>'order_item_id')::bigint, (x->>'qty')::numeric
  FROM jsonb_array_elements(p_items) x;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('shipments', v_id::text, 'shipment_draft_created', p_actor,
          jsonb_build_object('order_id', p_order_id,
                             'ship_from_address_id', p_ship_from_address_id,
                             'carrier', NULLIF(p_carrier, ''), 'servicelevel', NULLIF(p_servicelevel, ''),
                             'rate_amount', NULLIF(p_rate_amount, '')::numeric,
                             'items', p_items,
                             'claimed_at', v_claimed));

  RETURN QUERY SELECT v_id::text, (jsonb_build_object('c', v_claimed)->>'c');
END
$fn$;

-- create_manual_shipment re-created with the same ordered 42007 product
-- locks (full text; lock order 42001 -> 42007 -> 42006 as documented)
CREATE OR REPLACE FUNCTION create_manual_shipment(
  p_order_id bigint,
  p_group_buy_id bigint,
  p_ship_from_address_id bigint,
  p_expected_from jsonb,
  p_expected_to jsonb,
  p_carrier text,
  p_tracking_number text,
  p_cost text,
  p_items jsonb,
  p_box text,
  p_note text,
  p_actor text
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_order orders%ROWTYPE;
  v_addr receive_addresses%ROWTYPE;
  v_n int;
  v_distinct int;
  v_all_valid boolean;
  v_id bigint;
  v_tracking text;
  v_pid bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(42001, p_order_id::int);

  SELECT * INTO v_order FROM orders o
  WHERE o.id = p_order_id
    AND o.group_buy_id = p_group_buy_id
    AND o.status NOT IN ('cancelled', 'refunded')
    AND NOT o.hold_shipping
    AND COALESCE(o.address_line1, '') <> ''
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  FOR v_pid IN
    SELECT DISTINCT g.product_id FROM order_items oi
    JOIN group_buy_products g ON g.id = oi.group_buy_product_id
    WHERE oi.order_id = p_order_id
    ORDER BY 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('prod_digital_' || v_pid::text, 42007));
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM v_order_reconciliation r
    WHERE r.order_id = p_order_id
      AND r.recon_status IN ('matched', 'over')
      AND r.pending_payment_count = 0
  ) THEN RETURN; END IF;

  IF jsonb_build_object('street1', COALESCE(v_order.address_line1, ''),
                        'street2', COALESCE(v_order.address_line2, ''),
                        'city',    COALESCE(v_order.city, ''),
                        'state',   COALESCE(v_order.state_code, ''),
                        'zip',     COALESCE(v_order.postal_code, ''))
     IS DISTINCT FROM p_expected_to THEN RETURN; END IF;

  IF p_ship_from_address_id IS NOT NULL THEN
    SELECT * INTO v_addr FROM receive_addresses ra
    WHERE ra.id = p_ship_from_address_id AND ra.active
    FOR UPDATE;
    IF NOT FOUND THEN RETURN; END IF;
    IF jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                          'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                          'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
       IS DISTINCT FROM p_expected_from THEN RETURN; END IF;
  END IF;

  v_tracking := regexp_replace(UPPER(TRIM(COALESCE(p_tracking_number, ''))), '\s', '', 'g');
  IF TRIM(COALESCE(p_carrier, '')) = '' OR v_tracking = '' THEN RETURN; END IF;
  IF NULLIF(TRIM(COALESCE(p_cost, '')), '') IS NOT NULL
     AND NOT (TRIM(p_cost) ~ '^[0-9]+(\.[0-9]{1,2})?$' AND TRIM(p_cost)::numeric > 0) THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('track_' || regexp_replace(v_tracking, '[^A-Z0-9]', '', 'g'), 42006));

  IF EXISTS (
    SELECT 1 FROM shipments s2
    WHERE s2.finalized_at IS NOT NULL
      AND s2.finalized_at > now() - interval '120 days'
      AND s2.tracking_number IS NOT NULL
      AND regexp_replace(UPPER(s2.tracking_number), '[^A-Z0-9]', '', 'g')
          = regexp_replace(v_tracking, '[^A-Z0-9]', '', 'g')
  ) OR EXISTS (
    SELECT 1 FROM transfers t2
    WHERE t2.finalized_at IS NOT NULL
      AND t2.finalized_at > now() - interval '120 days'
      AND t2.tracking_number IS NOT NULL
      AND regexp_replace(UPPER(t2.tracking_number), '[^A-Z0-9]', '', 'g')
          = regexp_replace(v_tracking, '[^A-Z0-9]', '', 'g')
  ) THEN RETURN; END IF;

  SELECT count(*), count(DISTINCT x->>'order_item_id')
  INTO v_n, v_distinct
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR v_distinct <> v_n THEN RETURN; END IF;

  PERFORM 1 FROM order_items oi WHERE oi.order_id = p_order_id FOR UPDATE;

  SELECT bool_and(
           x->>'qty' ~ '^[0-9]+(\.[0-9]{1,2})?$'
           AND (x->>'qty')::numeric > 0
           AND oi.id IS NOT NULL
           AND (x->>'qty')::numeric
               <= COALESCE(oi.qty_override, oi.qty) - COALESCE(att.attributed, 0))
  INTO v_all_valid
  FROM jsonb_array_elements(p_items) x
  LEFT JOIN order_items oi
    ON oi.id = (x->>'order_item_id')::bigint
   AND oi.order_id = p_order_id
   AND NOT oi.direct_ship
   AND oi.removed_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM group_buy_products g
     JOIN products p ON p.id = g.product_id
     WHERE g.id = oi.group_buy_product_id AND p.digital)
  LEFT JOIN LATERAL (
    SELECT sum(si.qty) AS attributed
    FROM shipment_items si
    JOIN shipments sh ON sh.id = si.shipment_id
    WHERE si.order_item_id = oi.id
      AND COALESCE(sh.refund_status, '') <> 'SUCCESS'
  ) att ON true;
  IF NOT COALESCE(v_all_valid, false) THEN RETURN; END IF;

  INSERT INTO shipments (order_id, ship_from_address_id, from_label, from_address, destination, parcel,
                         carrier, tracking_number, label_cost_usd, rate_currency,
                         box, note, status, shipped_at, finalized_at, created_by)
  VALUES (p_order_id, p_ship_from_address_id,
          CASE WHEN p_ship_from_address_id IS NOT NULL THEN v_addr.label END,
          CASE WHEN p_ship_from_address_id IS NOT NULL THEN
            jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                               'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                               'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
          END,
          jsonb_build_object('name', COALESCE(NULLIF(v_order.contact_name, ''), 'Customer'),
                             'street1', COALESCE(v_order.address_line1, ''),
                             'street2', COALESCE(v_order.address_line2, ''),
                             'city', COALESCE(v_order.city, ''),
                             'state', COALESCE(v_order.state_code, ''),
                             'zip', COALESCE(v_order.postal_code, ''),
                             'country', 'US',
                             'phone', COALESCE(v_order.contact_phone, ''),
                             'email', COALESCE(v_order.contact_email::text, '')),
          '{}'::jsonb,
          LOWER(TRIM(p_carrier)), v_tracking,
          COALESCE(NULLIF(TRIM(COALESCE(p_cost, '')), '')::numeric, 0),
          CASE WHEN NULLIF(TRIM(COALESCE(p_cost, '')), '') IS NOT NULL THEN 'USD' END,
          NULLIF(TRIM(COALESCE(p_box, '')), ''), NULLIF(TRIM(COALESCE(p_note, '')), ''),
          'shipped', now(), now(), p_actor)
  RETURNING shipments.id INTO v_id;

  INSERT INTO shipment_items (shipment_id, order_item_id, qty)
  SELECT v_id, (x->>'order_item_id')::bigint, (x->>'qty')::numeric
  FROM jsonb_array_elements(p_items) x;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('shipments', v_id::text, 'manual_shipment_recorded', p_actor,
          jsonb_build_object('order_id', p_order_id,
                             'ship_from_address_id', p_ship_from_address_id,
                             'carrier', LOWER(TRIM(p_carrier)),
                             'tracking_number', v_tracking,
                             'cost', NULLIF(TRIM(COALESCE(p_cost, '')), ''),
                             'items', p_items));

  RETURN QUERY SELECT v_id::text;
END
$fn$;
