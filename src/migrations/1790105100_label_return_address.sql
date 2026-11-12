-- An order label can return to a saved address other than its ship-from.
--
-- Ian, 2026-11-12: "I need to be able to define the return address for the
-- label separately from the ship from address sent to shippo". Until now the
-- Ship dialog sent Shippo only address_from, and Shippo returns an
-- undelivered package to address_from when a shipment has no
-- address_return (UPS, USPS and FedEx honour address_return).
--
--   receive_addresses.return_address_id   the saved address that ORDER labels
--                                          shipped from this one return to;
--                                          NULL = itself. Set on Receiving >
--                                          Addresses (setReturnAddress); the
--                                          Ship dialog preselects it and the
--                                          operator may pick another for one
--                                          label. An archived target is kept
--                                          (restoring it restores the pairing);
--                                          the dialog makes the operator pick
--                                          until then.
--   shipments.return_address_id /          which saved address the label's
--   shipments.return_address               address_return came from and its
--                                          content as quoted (the from_address
--                                          shape); both NULL when the label
--                                          returns to its ship-from.
--
-- create_shipment_draft takes the pair as two trailing parameters with
-- DEFAULT NULL (the old 15-argument call still resolves, so the UI released
-- before this migration keeps buying labels exactly as before) and
-- content-checks the live, active row exactly as it does the ship-from; the
-- purchase claim (markShipmentPurchaseStarted) re-proves it before money
-- moves. Both receive_addresses rows are locked in id order, so two drafts
-- whose ship-from and return are swapped cannot deadlock.
--
-- Transfers keep returning to their ship-from: they move stock between our
-- own addresses. Manual records (a label bought outside the app) carry no
-- return address here.

DO $mig$
BEGIN
  IF current_user <> 'neondb_owner' THEN
    RAISE EXCEPTION '1790105100 must be applied as neondb_owner, not %', current_user;
  END IF;
END
$mig$;

ALTER TABLE receive_addresses
  ADD COLUMN IF NOT EXISTS return_address_id bigint REFERENCES receive_addresses(id);
ALTER TABLE receive_addresses DROP CONSTRAINT IF EXISTS receive_addresses_return_not_self;
ALTER TABLE receive_addresses
  ADD CONSTRAINT receive_addresses_return_not_self CHECK (return_address_id <> id);

ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS return_address_id bigint REFERENCES receive_addresses(id),
  ADD COLUMN IF NOT EXISTS return_address jsonb;
ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_return_address_pair;
ALTER TABLE shipments
  ADD CONSTRAINT shipments_return_address_pair
  CHECK ((return_address_id IS NULL) = (return_address IS NULL));

-- the old signature goes in the same transaction as the new one is created:
-- a second overload would make every 15-argument call ambiguous
DROP FUNCTION IF EXISTS public.create_shipment_draft(bigint, bigint, bigint, jsonb, jsonb, jsonb, text, text, text, text, text, jsonb, text, text, text);

CREATE OR REPLACE FUNCTION public.create_shipment_draft(p_order_id bigint, p_group_buy_id bigint, p_ship_from_address_id bigint, p_expected_from jsonb, p_expected_to jsonb, p_parcel jsonb, p_carrier text, p_servicelevel text, p_rate_amount text, p_rate_currency text, p_shippo_rate_id text, p_items jsonb, p_box text, p_note text, p_actor text, p_return_address_id bigint DEFAULT NULL, p_expected_return jsonb DEFAULT NULL)
 RETURNS TABLE(id text, claimed_at text)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_order orders%ROWTYPE;
  v_addr receive_addresses%ROWTYPE;
  v_ret receive_addresses%ROWTYPE;
  v_n int;
  v_distinct int;
  v_all_valid boolean;
  v_id bigint;
  v_claimed timestamptz;
  v_pid bigint;
  v_server_to jsonb;
  v_server_from jsonb;
  v_server_return jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(42001, p_order_id::int);

  SELECT * INTO v_order FROM orders o
  WHERE o.id = p_order_id
    AND o.group_buy_id = p_group_buy_id
    AND o.status NOT IN ('cancelled', 'refunded')
    AND NOT o.hold_shipping
    AND COALESCE(o.address_line1, '') <> ''
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'order_gate',
                               'detail', 'order missing for campaign, cancelled/refunded, held, or address blank',
                               'sent_group_buy_id', p_group_buy_id));
    RETURN;
  END IF;

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
  ) THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'money_gate'));
    RETURN;
  END IF;

  v_server_to := jsonb_build_object('street1', COALESCE(v_order.address_line1, ''),
                                    'street2', COALESCE(v_order.address_line2, ''),
                                    'city',    COALESCE(v_order.city, ''),
                                    'state',   COALESCE(v_order.state_code, ''),
                                    'zip',     COALESCE(v_order.postal_code, ''));
  IF v_server_to IS DISTINCT FROM p_expected_to THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'ship_to_cas',
                               'server', v_server_to, 'client', p_expected_to));
    RETURN;
  END IF;

  -- both saved addresses this label names, locked in id order (a draft
  -- shipping A->returns B and one shipping B->returns A cannot deadlock)
  PERFORM 1 FROM receive_addresses ra
  WHERE ra.id IN (p_ship_from_address_id, p_return_address_id)
  ORDER BY ra.id
  FOR UPDATE;

  SELECT * INTO v_addr FROM receive_addresses ra
  WHERE ra.id = p_ship_from_address_id AND ra.active
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'from_missing',
                               'ship_from_address_id', p_ship_from_address_id));
    RETURN;
  END IF;
  v_server_from := jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                                      'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                                      'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email);
  IF v_server_from IS DISTINCT FROM p_expected_from THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'ship_from_cas',
                               'server', v_server_from, 'client', p_expected_from));
    RETURN;
  END IF;

  -- the return address (1790105100): none = Shippo returns to the ship-from;
  -- else the live, active saved row must equal what the rate was quoted with
  IF p_return_address_id IS NULL THEN
    IF p_expected_return IS NOT NULL THEN
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
              jsonb_build_object('order_id', p_order_id, 'guard', 'return_shape'));
      RETURN;
    END IF;
  ELSE
    SELECT * INTO v_ret FROM receive_addresses ra
    WHERE ra.id = p_return_address_id AND ra.active
    FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
              jsonb_build_object('order_id', p_order_id, 'guard', 'return_missing',
                                 'return_address_id', p_return_address_id));
      RETURN;
    END IF;
    v_server_return := jsonb_build_object('name', v_ret.name, 'street1', v_ret.street1, 'street2', v_ret.street2,
                                          'city', v_ret.city, 'state', v_ret.state, 'zip', v_ret.zip,
                                          'country', v_ret.country, 'phone', v_ret.phone, 'email', v_ret.email);
    IF v_server_return IS DISTINCT FROM p_expected_return THEN
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
              jsonb_build_object('order_id', p_order_id, 'guard', 'return_cas',
                                 'server', v_server_return, 'client', p_expected_return));
      RETURN;
    END IF;
  END IF;

  IF NULLIF(p_shippo_rate_id, '') IS NULL THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'no_rate_id'));
    RETURN;
  END IF;

  SELECT count(*), count(DISTINCT x->>'order_item_id')
  INTO v_n, v_distinct
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR v_distinct <> v_n THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'items_shape', 'items', p_items));
    RETURN;
  END IF;

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
  IF NOT COALESCE(v_all_valid, false) THEN
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    VALUES ('shipments', p_order_id::text, 'draft_refused', p_actor,
            jsonb_build_object('order_id', p_order_id, 'guard', 'line_validation', 'items', p_items));
    RETURN;
  END IF;

  INSERT INTO shipments (order_id, ship_from_address_id, from_label, from_address, destination, parcel,
                         carrier, servicelevel, rate_amount, rate_currency, shippo_rate_id,
                         box, note, status, label_cost_usd, created_by, purchase_started_at,
                         return_address_id, return_address)
  VALUES (p_order_id, v_addr.id, v_addr.label,
          v_server_from,
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
          'pending', 0, p_actor, now(),
          v_ret.id, v_server_return)
  RETURNING shipments.id, shipments.purchase_started_at INTO v_id, v_claimed;

  INSERT INTO shipment_items (shipment_id, order_item_id, qty)
  SELECT v_id, (x->>'order_item_id')::bigint, (x->>'qty')::numeric
  FROM jsonb_array_elements(p_items) x;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('shipments', v_id::text, 'shipment_draft_created', p_actor,
          jsonb_build_object('order_id', p_order_id,
                             'ship_from_address_id', p_ship_from_address_id,
                             'return_address_id', p_return_address_id,
                             'carrier', NULLIF(p_carrier, ''), 'servicelevel', NULLIF(p_servicelevel, ''),
                             'rate_amount', NULLIF(p_rate_amount, '')::numeric,
                             'items', p_items,
                             'claimed_at', v_claimed));

  RETURN QUERY SELECT v_id::text, (jsonb_build_object('c', v_claimed)->>'c');
END
$function$;

INSERT INTO claude_migrations_applied (filename)
SELECT '1790105100_label_return_address.sql'
WHERE NOT EXISTS (SELECT 1 FROM claude_migrations_applied WHERE filename = '1790105100_label_return_address.sql');
