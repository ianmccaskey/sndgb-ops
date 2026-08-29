-- create_shipment_draft(): the order-shipment twin of create_transfer_draft
-- (1786471800). Creates the draft BEFORE the label is purchased so a failed
-- or interrupted purchase never leaves a paid label with no record, and
-- validates per-line attribution against remaining-to-pack under the same
-- per-order advisory lock (class 42001) every reconciliation-affecting and
-- item-mutation write takes — two concurrent boxes cannot double-pack a
-- line, and an item edit cannot race a draft.
-- Zero rows = refused (order gates, CAS drift, bad items, over-attribution).
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
  p_items jsonb,          -- [{order_item_id, qty}] with qty as a string
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
BEGIN
  PERFORM pg_advisory_xact_lock(42001, p_order_id::int);

  -- order gates, row-locked: right campaign, shippable status, not held,
  -- and a real street address to put on a label
  SELECT * INTO v_order FROM orders o
  WHERE o.id = p_order_id
    AND o.group_buy_id = p_group_buy_id
    AND o.status NOT IN ('cancelled', 'refunded')
    AND NOT o.hold_shipping
    AND COALESCE(o.address_line1, '') <> ''
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  -- money gates: fully collected AND no unresolved payment evidence (the
  -- same rule that admits an order to the ready queue). The 42001 lock
  -- serializes this read against every money writer.
  IF NOT EXISTS (
    SELECT 1 FROM v_order_reconciliation r
    WHERE r.order_id = p_order_id
      AND r.recon_status IN ('matched', 'over')
      AND r.pending_payment_count = 0
  ) THEN RETURN; END IF;

  -- ship-to CAS: the quote was priced for the address the operator SAW.
  -- If the order's address was corrected since, refuse — a label to the
  -- old address is money spent on a wrong destination.
  IF jsonb_build_object('street1', COALESCE(v_order.address_line1, ''),
                        'street2', COALESCE(v_order.address_line2, ''),
                        'city',    COALESCE(v_order.city, ''),
                        'state',   COALESCE(v_order.state_code, ''),
                        'zip',     COALESCE(v_order.postal_code, ''))
     IS DISTINCT FROM p_expected_to THEN RETURN; END IF;

  -- ship-from: active, content-matched to what the quote used; the stored
  -- snapshot is built from THIS locked read, never from the client
  SELECT * INTO v_addr FROM receive_addresses ra
  WHERE ra.id = p_ship_from_address_id AND ra.active;
  IF NOT FOUND THEN RETURN; END IF;
  IF jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                        'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                        'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
     IS DISTINCT FROM p_expected_from THEN RETURN; END IF;

  IF NULLIF(p_shippo_rate_id, '') IS NULL THEN RETURN; END IF;

  -- attribution payload: at least one line, no duplicate lines
  SELECT count(*), count(DISTINCT x->>'order_item_id')
  INTO v_n, v_distinct
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR v_distinct <> v_n THEN RETURN; END IF;

  -- belt: row-lock every line of the order (the advisory lock already
  -- serializes attribution writers; this also blocks any future direct
  -- row-level writer that might not take 42001)
  PERFORM 1 FROM order_items oi WHERE oi.order_id = p_order_id FOR UPDATE;

  -- every line must be THIS order's, packable (non-direct, non-removed),
  -- with a valid qty that fits inside remaining = effective - attributed
  -- over non-voided shipments (drafts INCLUDED - a draft reserves)
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
