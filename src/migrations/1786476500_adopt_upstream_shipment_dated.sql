-- Codex post-push review: adopted shipments were stamped shipped_at =
-- now(), rewriting boxes that left days ago as same-day shipments. The
-- fn now takes p_shipped_date (YYYY-MM-DD from the upstream item
-- shipped_date; '' = unknown -> now() with the note saying so), and the
-- client groups adopted lines BY DATE so mixed dates become separate
-- shipment rows, each with its true date. finalized_at stays now() —
-- that is the record-creation moment, not the ship moment. A malformed
-- date REFUSES (fail closed) rather than silently stamping today.
DROP FUNCTION IF EXISTS adopt_upstream_shipment(bigint, bigint, jsonb, text, text);

CREATE OR REPLACE FUNCTION adopt_upstream_shipment(
  p_order_id bigint,
  p_group_buy_id bigint,
  p_items jsonb,                   -- [{order_item_id, qty}] with qty as a string
  p_shipped_date text,             -- 'YYYY-MM-DD' upstream ship date; '' = unknown
  p_note text,
  p_actor text
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v_order orders%ROWTYPE;
  v_n int;
  v_distinct int;
  v_all_valid boolean;
  v_id bigint;
  v_shipped timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(42001, p_order_id::int);

  IF NULLIF(TRIM(COALESCE(p_shipped_date, '')), '') IS NULL THEN
    v_shipped := now();
  ELSIF TRIM(p_shipped_date) ~ '^\d{4}-\d{2}-\d{2}$' THEN
    v_shipped := TRIM(p_shipped_date)::date::timestamptz;
    -- a future or absurdly old date is upstream garbage, not history
    IF v_shipped > now() OR v_shipped < now() - interval '2 years' THEN RETURN; END IF;
  ELSE
    RETURN;
  END IF;

  SELECT * INTO v_order FROM orders o
  WHERE o.id = p_order_id
    AND o.group_buy_id = p_group_buy_id
    AND o.status NOT IN ('cancelled', 'refunded')
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

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
                         box, note, status, shipped_at, finalized_at, b44_pushed_at, created_by)
  VALUES (p_order_id, NULL, NULL, NULL,
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
          'upstream', NULL, 0, NULL,
          NULL, NULLIF(TRIM(COALESCE(p_note, '')), ''),
          'shipped', v_shipped, now(), now(), p_actor)
  RETURNING shipments.id INTO v_id;

  INSERT INTO shipment_items (shipment_id, order_item_id, qty)
  SELECT v_id, (x->>'order_item_id')::bigint, (x->>'qty')::numeric
  FROM jsonb_array_elements(p_items) x;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('shipments', v_id::text, 'upstream_shipment_adopted', p_actor,
          jsonb_build_object('order_id', p_order_id, 'items', p_items,
                             'shipped_date', NULLIF(TRIM(COALESCE(p_shipped_date, '')), ''),
                             'note', p_note));

  RETURN QUERY SELECT v_id::text;
END
$fn$;
