-- create_manual_shipment(): the born-FINALIZED twin of create_shipment_draft
-- for labels bought OUTSIDE the app (precedent: create_manual_transfer,
-- 1786472900/1786473200). No draft lifecycle, no lease, no rate — nothing
-- was charged through us, so any gate failure refuses the WHOLE record
-- harmlessly. Same order/money/ship-to gates and attribution validation as
-- the draft fn; writes status='shipped' with shipped_at = finalized_at =
-- now(). Ship-from is OPTIONAL (a hand-bought label may have no
-- receive-address provenance): NULL skips the address CAS and snapshot.
-- Cross-path duplicate refusal: the same normalized tracking fingerprint on
-- ANY finalized shipment OR transfer within 120 days (the carrier
-- number-recycling window) refuses — an operator retyping a label the app
-- already bought, or pasting a transfer's label, must not double-record.
-- The manual-only unique index (1786473400) backstops the manual-vs-manual
-- race.
CREATE OR REPLACE FUNCTION create_manual_shipment(
  p_order_id bigint,
  p_group_buy_id bigint,
  p_ship_from_address_id bigint,   -- NULL = unknown provenance
  p_expected_from jsonb,           -- ignored when ship-from is NULL
  p_expected_to jsonb,
  p_carrier text,
  p_tracking_number text,
  p_cost text,                     -- optional; > 0 when given
  p_items jsonb,                   -- [{order_item_id, qty}] with qty as a string
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
    WHERE ra.id = p_ship_from_address_id AND ra.active;
    IF NOT FOUND THEN RETURN; END IF;
    IF jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                          'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                          'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
       IS DISTINCT FROM p_expected_from THEN RETURN; END IF;
  END IF;

  -- canonical COMPACT tracking: UPPER + whitespace stripped (receipts print
  -- grouped digits; whitespace is never part of a tracking number)
  v_tracking := regexp_replace(UPPER(TRIM(COALESCE(p_tracking_number, ''))), '\s', '', 'g');
  IF TRIM(COALESCE(p_carrier, '')) = '' OR v_tracking = '' THEN RETURN; END IF;
  IF NULLIF(TRIM(COALESCE(p_cost, '')), '') IS NOT NULL
     AND NOT (TRIM(p_cost) ~ '^[0-9]+(\.[0-9]{1,2})?$' AND TRIM(p_cost)::numeric > 0) THEN RETURN; END IF;

  -- cross-path duplicate refusal within the recycling window
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
