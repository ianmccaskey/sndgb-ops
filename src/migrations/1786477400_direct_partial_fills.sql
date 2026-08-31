-- PARTIAL direct-ship fills (Ian: "the customer has 60 direct ship but
-- the vendor did not direct ship to customers, they sent everything to
-- us — we have to fill those direct ships now"). A transfer linked to a
-- direct-ship order line may now carry LESS than the ordered quantity:
-- fills accumulate across finalized non-voided transfers (matched on
-- the line's product), and the line stamps direct_fulfilled_at only
-- when the cumulative total covers COALESCE(qty_override, qty). The
-- completing transfer becomes direct_fulfilled_transfer_id (the order
-- sheet's tracking join); earlier partial trackings live in the
-- transfer log. The one-unfinalized-draft-per-line reservation
-- (transfers_direct_item_active_uniq WHERE finalized_at IS NULL) is
-- unchanged — partials are sequential, one label at a time.
-- FILLS COUNT ONLY CURRENT-ADDRESS TRANSFERS (Codex round 1): the
-- cumulative sum requires each contributing transfer's destination
-- snapshot to match the order's CURRENT ship-to — a partial sent to an
-- address the customer later corrected stops counting (those units
-- went elsewhere; visible progress resets and the operator
-- remediates). And a line whose current-address fills already cover
-- the ordered qty REFUSES a new linked transfer — if the stamp was
-- missed on a transient gate (hold/unpaid at finalize time), the
-- remediation is the order sheet's manual vendor-shipped mark, never
-- shipping more stock.
-- ACCEPTED (existing class): a refund SUCCESS on a contributing
-- transfer after the line completed does NOT un-stamp it — refunding a
-- label is not proof goods didn't ship; the sheet's manual undo is the
-- remediation path. The Shippo draft path's stamp lives in the
-- finalizeTransfer action (source-controlled, same cumulative rule).
-- Signatures unchanged — CREATE OR REPLACE only. Applied live 2026-08-31.

CREATE OR REPLACE FUNCTION public.create_transfer_draft(p_from_address_id bigint, p_destination_label text, p_destination jsonb, p_parcel jsonb, p_carrier text, p_servicelevel text, p_rate_amount text, p_rate_currency text, p_shippo_rate_id text, p_items jsonb, p_allow_over_onhand boolean, p_expected_from jsonb, p_destination_id bigint, p_expected_destination jsonb, p_note text, p_actor text, p_direct_order_item_id bigint, p_group_buy_id bigint, p_source_package_id bigint, p_dest_receive_address_id bigint)
 RETURNS TABLE(id text, claimed_at text)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_addr receive_addresses%ROWTYPE;
  v_n int;
  v_all_valid boolean;
  v_any_over boolean;
  v_id bigint;
  v_claimed timestamptz;
  v_reclaimed bigint;
  v_src bigint;
  v_dest bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(42004, p_from_address_id::int);
  IF p_direct_order_item_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('direct_line_' || p_direct_order_item_id::text, 42005));
  END IF;

  SELECT * INTO v_addr FROM receive_addresses ra
  WHERE ra.id = p_from_address_id AND ra.active
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_addr.transfer_origin_id IS NOT NULL THEN RETURN; END IF;

  IF jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                        'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                        'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
     IS DISTINCT FROM p_expected_from THEN RETURN; END IF;

  IF TRIM(COALESCE(p_destination_label, '')) = '' OR NULLIF(p_shippo_rate_id, '') IS NULL THEN RETURN; END IF;

  IF p_destination_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM transfer_destinations td
      WHERE td.id = p_destination_id AND td.active
        AND jsonb_build_object('name', td.name, 'street1', td.street1, 'street2', td.street2,
                               'city', td.city, 'state', td.state, 'zip', td.zip,
                               'country', td.country, 'phone', td.phone, 'email', td.email)
            = p_expected_destination
    ) THEN RETURN; END IF;
  END IF;

  -- SOURCE PACKAGE provenance (the box being sent): stored only when it
  -- is a received package whose address resolves to this origin group —
  -- anything else silently records NULL rather than refusing the money
  -- path over a provenance tag
  v_src := NULL;
  IF p_source_package_id IS NOT NULL THEN
    SELECT ip.id INTO v_src FROM inbound_packages ip
    JOIN receive_addresses ra2 ON ra2.id = ip.receive_address_id
    WHERE ip.id = p_source_package_id AND ip.received_at IS NOT NULL
      AND COALESCE(ra2.transfer_origin_id, ra2.id) = p_from_address_id;
  END IF;

  v_dest := NULL;
  IF p_dest_receive_address_id IS NOT NULL THEN
    SELECT ra3.id INTO v_dest FROM receive_addresses ra3
    WHERE ra3.id = p_dest_receive_address_id AND ra3.active;
  END IF;

  SELECT count(*), bool_and(x->>'qty' ~ '^[0-9]+(\.[0-9]{1,2})?$' AND (x->>'qty')::numeric > 0)
  INTO v_n, v_all_valid
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR NOT COALESCE(v_all_valid, false) THEN RETURN; END IF;

  IF p_direct_order_item_id IS NOT NULL THEN
    -- PARTIAL FILLS: the transfer must carry a positive quantity of the
    -- line's product — not necessarily the full ordered quantity; the
    -- stamp (at finalize) is what requires cumulative coverage
    PERFORM 1
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
    LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
    WHERE oi.id = p_direct_order_item_id
      AND oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL
      AND o.status NOT IN ('cancelled', 'refunded')
      AND o.group_buy_id = p_group_buy_id
      AND gbp.group_buy_id = o.group_buy_id
      AND NOT o.hold_shipping
      AND r.recon_status IN ('matched', 'over')
      AND r.pending_payment_count = 0
      AND COALESCE(o.address_line1, '') <> ''
      AND COALESCE(p_destination->>'street1', '') = COALESCE(o.address_line1, '')
      AND COALESCE(p_destination->>'street2', '') = COALESCE(o.address_line2, '')
      AND COALESCE(p_destination->>'city', '')    = COALESCE(o.city, '')
      AND COALESCE(p_destination->>'state', '')   = COALESCE(o.state_code, '')
      AND COALESCE(p_destination->>'zip', '')     = COALESCE(o.postal_code, '')
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) x
        WHERE (x->>'product_id')::bigint = gbp.product_id
          AND (x->>'qty')::numeric > 0
      )
    FOR UPDATE OF oi, o;
    IF NOT FOUND THEN RETURN; END IF;
    -- already covered by CURRENT-address fills: refuse a new linked
    -- transfer — a missed stamp is fixed from the order sheet (manual
    -- vendor-shipped mark), never by shipping more stock
    IF (SELECT COALESCE(sum(ti0.qty), 0)
        FROM transfers t5
        JOIN transfer_items ti0 ON ti0.transfer_id = t5.id
        JOIN order_items oi6 ON oi6.id = p_direct_order_item_id
        JOIN group_buy_products g5 ON g5.id = oi6.group_buy_product_id AND ti0.product_id = g5.product_id
        JOIN orders o5 ON o5.id = oi6.order_id
        WHERE t5.direct_order_item_id = p_direct_order_item_id
          AND t5.finalized_at IS NOT NULL
          AND COALESCE(t5.refund_status, '') <> 'SUCCESS'
          AND COALESCE(t5.destination->>'street1', '') = COALESCE(o5.address_line1, '')
          AND COALESCE(t5.destination->>'street2', '') = COALESCE(o5.address_line2, '')
          AND COALESCE(t5.destination->>'city', '')    = COALESCE(o5.city, '')
          AND COALESCE(t5.destination->>'state', '')   = COALESCE(o5.state_code, '')
          AND COALESCE(t5.destination->>'zip', '')     = COALESCE(o5.postal_code, ''))
       >= (SELECT COALESCE(oi7.qty_override, oi7.qty) FROM order_items oi7 WHERE oi7.id = p_direct_order_item_id)
    THEN RETURN; END IF;
    IF EXISTS (
      SELECT 1 FROM transfers t2
      WHERE t2.direct_order_item_id = p_direct_order_item_id AND t2.finalized_at IS NULL
        AND ((t2.purchase_attempted_at IS NOT NULL AND t2.purchase_attempted_at > now() - interval '30 days')
             OR (t2.purchase_attempted_at IS NULL AND t2.created_at > now() - interval '7 days'))
    ) THEN RETURN; END IF;
    WITH gone AS (
      UPDATE transfers t2 SET direct_order_item_id = NULL, direct_link_reclaimed_at = now()
      WHERE t2.direct_order_item_id = p_direct_order_item_id AND t2.finalized_at IS NULL
      RETURNING t2.id
    )
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    SELECT 'transfers', gone.id::text, 'direct_link_reclaimed', p_actor,
           jsonb_build_object('direct_order_item_id', p_direct_order_item_id,
                              'reason', 'expired unfinalized reservation superseded by a new draft')
    FROM gone;
    GET DIAGNOSTICS v_reclaimed = ROW_COUNT;
  END IF;

  SELECT COALESCE(bool_or((x->>'qty')::numeric > COALESCE(inv.on_hand_qty, 0) - COALESCE(res.reserved, 0)), false)
  INTO v_any_over
  FROM jsonb_array_elements(p_items) x
  LEFT JOIN LATERAL (
    SELECT sum(i.on_hand_qty) AS on_hand_qty
    FROM v_address_inventory i
    JOIN receive_addresses ga ON ga.id = i.receive_address_id
    WHERE i.product_id = (x->>'product_id')::bigint
      AND COALESCE(ga.transfer_origin_id, ga.id) = p_from_address_id
  ) inv ON true
  LEFT JOIN LATERAL (
    SELECT sum(ti.qty) AS reserved
    FROM transfers t
    JOIN transfer_items ti ON ti.transfer_id = t.id AND ti.product_id = (x->>'product_id')::bigint
    JOIN receive_addresses tra ON tra.id = t.from_address_id
    WHERE COALESCE(tra.transfer_origin_id, tra.id) = p_from_address_id
      AND t.finalized_at IS NULL
      AND ((t.purchase_attempted_at IS NOT NULL AND t.purchase_attempted_at > now() - interval '30 days')
           OR (t.purchase_attempted_at IS NULL AND t.created_at > now() - interval '7 days'))
  ) res ON true;
  IF v_any_over AND NOT p_allow_over_onhand THEN RETURN; END IF;

  INSERT INTO transfers (from_address_id, from_label, from_address, destination_label, destination, parcel,
                         carrier, servicelevel, rate_amount, rate_currency, shippo_rate_id, note, created_by,
                         purchase_started_at, direct_order_item_id, source_package_id, dest_receive_address_id)
  VALUES (v_addr.id, v_addr.label,
          jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                             'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                             'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email),
          TRIM(p_destination_label), p_destination, p_parcel,
          NULLIF(p_carrier, ''), NULLIF(p_servicelevel, ''), NULLIF(p_rate_amount, '')::numeric,
          NULLIF(p_rate_currency, ''), NULLIF(p_shippo_rate_id, ''),
          NULLIF(TRIM(COALESCE(p_note, '')), ''), p_actor, now(), p_direct_order_item_id, v_src, v_dest)
  RETURNING transfers.id, transfers.purchase_started_at INTO v_id, v_claimed;

  INSERT INTO transfer_items (transfer_id, product_id, qty)
  SELECT v_id, (x->>'product_id')::bigint, (x->>'qty')::numeric
  FROM jsonb_array_elements(p_items) x;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('transfers', v_id::text, 'transfer_draft_created', p_actor,
          jsonb_build_object('from_address_id', p_from_address_id, 'destination_label', TRIM(p_destination_label),
                             'carrier', NULLIF(p_carrier, ''), 'servicelevel', NULLIF(p_servicelevel, ''),
                             'rate_amount', NULLIF(p_rate_amount, '')::numeric,
                             'items', p_items,
                             'over_onhand_override', v_any_over,
                             'direct_order_item_id', p_direct_order_item_id,
                             'group_buy_id', p_group_buy_id,
                             'direct_links_reclaimed', COALESCE(v_reclaimed, 0),
                             'source_package_id', v_src,
                             'dest_receive_address_id', v_dest,
                             'claimed_at', v_claimed));

  RETURN QUERY SELECT v_id::text, (jsonb_build_object('c', v_claimed)->>'c');
END
$function$;

CREATE OR REPLACE FUNCTION public.create_manual_transfer(p_from_address_id bigint, p_destination_label text, p_destination jsonb, p_carrier text, p_tracking_number text, p_cost text, p_items jsonb, p_allow_over_onhand boolean, p_expected_from jsonb, p_destination_id bigint, p_expected_destination jsonb, p_note text, p_actor text, p_direct_order_item_id bigint, p_group_buy_id bigint, p_source_package_id bigint, p_dest_receive_address_id bigint)
 RETURNS TABLE(id text)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_addr receive_addresses%ROWTYPE;
  v_n int;
  v_all_valid boolean;
  v_any_over boolean;
  v_id bigint;
  v_reclaimed bigint;
  v_tracking text;
  v_src bigint;
  v_dest bigint;
  v_in bigint;
  v_stamped int;
BEGIN
  PERFORM pg_advisory_xact_lock(42004, p_from_address_id::int);
  IF p_direct_order_item_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('direct_line_' || p_direct_order_item_id::text, 42005));
  END IF;

  SELECT * INTO v_addr FROM receive_addresses ra
  WHERE ra.id = p_from_address_id AND ra.active
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_addr.transfer_origin_id IS NOT NULL THEN RETURN; END IF;

  IF jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                        'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                        'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
     IS DISTINCT FROM p_expected_from THEN RETURN; END IF;

  v_tracking := regexp_replace(UPPER(TRIM(COALESCE(p_tracking_number, ''))), '\s', '', 'g');

  IF TRIM(COALESCE(p_destination_label, '')) = ''
     OR TRIM(COALESCE(p_carrier, '')) = ''
     OR v_tracking = '' THEN RETURN; END IF;
  IF NULLIF(TRIM(COALESCE(p_cost, '')), '') IS NOT NULL
     AND NOT (TRIM(p_cost) ~ '^[0-9]+(\.[0-9]{1,2})?$' AND TRIM(p_cost)::numeric > 0) THEN RETURN; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('track_' || regexp_replace(v_tracking, '[^A-Z0-9]', '', 'g'), 42006));

  IF EXISTS (
    SELECT 1 FROM transfers t3
    WHERE t3.finalized_at IS NOT NULL
      AND t3.finalized_at > now() - interval '120 days'
      AND t3.tracking_number IS NOT NULL
      AND regexp_replace(UPPER(t3.tracking_number), '[^A-Z0-9]', '', 'g')
          = regexp_replace(v_tracking, '[^A-Z0-9]', '', 'g')
  ) OR EXISTS (
    SELECT 1 FROM shipments s3
    WHERE s3.finalized_at IS NOT NULL
      AND s3.finalized_at > now() - interval '120 days'
      AND s3.tracking_number IS NOT NULL
      AND regexp_replace(UPPER(s3.tracking_number), '[^A-Z0-9]', '', 'g')
          = regexp_replace(v_tracking, '[^A-Z0-9]', '', 'g')
  ) THEN RETURN; END IF;

  IF p_destination_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM transfer_destinations td
      WHERE td.id = p_destination_id AND td.active
        AND jsonb_build_object('name', td.name, 'street1', td.street1, 'street2', td.street2,
                               'city', td.city, 'state', td.state, 'zip', td.zip,
                               'country', td.country, 'phone', td.phone, 'email', td.email)
            = p_expected_destination
    ) THEN RETURN; END IF;
  END IF;

  v_src := NULL;
  IF p_source_package_id IS NOT NULL THEN
    SELECT ip.id INTO v_src FROM inbound_packages ip
    JOIN receive_addresses ra2 ON ra2.id = ip.receive_address_id
    WHERE ip.id = p_source_package_id AND ip.received_at IS NOT NULL
      AND COALESCE(ra2.transfer_origin_id, ra2.id) = p_from_address_id;
  END IF;

  v_dest := NULL;
  IF p_dest_receive_address_id IS NOT NULL THEN
    SELECT ra3.id INTO v_dest FROM receive_addresses ra3
    WHERE ra3.id = p_dest_receive_address_id AND ra3.active;
  END IF;

  SELECT count(*), bool_and(x->>'qty' ~ '^[0-9]+(\.[0-9]{1,2})?$' AND (x->>'qty')::numeric > 0)
  INTO v_n, v_all_valid
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR NOT COALESCE(v_all_valid, false) THEN RETURN; END IF;

  IF p_direct_order_item_id IS NOT NULL THEN
    -- PARTIAL FILLS: positive quantity of the line's product suffices;
    -- the stamp below requires cumulative coverage
    PERFORM 1
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
    LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
    WHERE oi.id = p_direct_order_item_id
      AND oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL
      AND o.status NOT IN ('cancelled', 'refunded')
      AND o.group_buy_id = p_group_buy_id
      AND gbp.group_buy_id = o.group_buy_id
      AND NOT o.hold_shipping
      AND r.recon_status IN ('matched', 'over')
      AND r.pending_payment_count = 0
      AND COALESCE(o.address_line1, '') <> ''
      AND COALESCE(p_destination->>'street1', '') = COALESCE(o.address_line1, '')
      AND COALESCE(p_destination->>'street2', '') = COALESCE(o.address_line2, '')
      AND COALESCE(p_destination->>'city', '')    = COALESCE(o.city, '')
      AND COALESCE(p_destination->>'state', '')   = COALESCE(o.state_code, '')
      AND COALESCE(p_destination->>'zip', '')     = COALESCE(o.postal_code, '')
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) x
        WHERE (x->>'product_id')::bigint = gbp.product_id
          AND (x->>'qty')::numeric > 0
      )
    FOR UPDATE OF oi, o;
    IF NOT FOUND THEN RETURN; END IF;
    -- already covered by CURRENT-address fills: refuse a new linked
    -- transfer — a missed stamp is fixed from the order sheet (manual
    -- vendor-shipped mark), never by shipping more stock
    IF (SELECT COALESCE(sum(ti0.qty), 0)
        FROM transfers t5
        JOIN transfer_items ti0 ON ti0.transfer_id = t5.id
        JOIN order_items oi6 ON oi6.id = p_direct_order_item_id
        JOIN group_buy_products g5 ON g5.id = oi6.group_buy_product_id AND ti0.product_id = g5.product_id
        JOIN orders o5 ON o5.id = oi6.order_id
        WHERE t5.direct_order_item_id = p_direct_order_item_id
          AND t5.finalized_at IS NOT NULL
          AND COALESCE(t5.refund_status, '') <> 'SUCCESS'
          AND COALESCE(t5.destination->>'street1', '') = COALESCE(o5.address_line1, '')
          AND COALESCE(t5.destination->>'street2', '') = COALESCE(o5.address_line2, '')
          AND COALESCE(t5.destination->>'city', '')    = COALESCE(o5.city, '')
          AND COALESCE(t5.destination->>'state', '')   = COALESCE(o5.state_code, '')
          AND COALESCE(t5.destination->>'zip', '')     = COALESCE(o5.postal_code, ''))
       >= (SELECT COALESCE(oi7.qty_override, oi7.qty) FROM order_items oi7 WHERE oi7.id = p_direct_order_item_id)
    THEN RETURN; END IF;
    IF EXISTS (
      SELECT 1 FROM transfers t2
      WHERE t2.direct_order_item_id = p_direct_order_item_id AND t2.finalized_at IS NULL
        AND ((t2.purchase_attempted_at IS NOT NULL AND t2.purchase_attempted_at > now() - interval '30 days')
             OR (t2.purchase_attempted_at IS NULL AND t2.created_at > now() - interval '7 days'))
    ) THEN RETURN; END IF;
    WITH gone AS (
      UPDATE transfers t2 SET direct_order_item_id = NULL, direct_link_reclaimed_at = now()
      WHERE t2.direct_order_item_id = p_direct_order_item_id AND t2.finalized_at IS NULL
      RETURNING t2.id
    )
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    SELECT 'transfers', gone.id::text, 'direct_link_reclaimed', p_actor,
           jsonb_build_object('direct_order_item_id', p_direct_order_item_id,
                              'reason', 'expired unfinalized reservation superseded by a manual transfer')
    FROM gone;
    GET DIAGNOSTICS v_reclaimed = ROW_COUNT;
  END IF;

  SELECT COALESCE(bool_or((x->>'qty')::numeric > COALESCE(inv.on_hand_qty, 0) - COALESCE(res.reserved, 0)), false)
  INTO v_any_over
  FROM jsonb_array_elements(p_items) x
  LEFT JOIN LATERAL (
    SELECT sum(i.on_hand_qty) AS on_hand_qty
    FROM v_address_inventory i
    JOIN receive_addresses ga ON ga.id = i.receive_address_id
    WHERE i.product_id = (x->>'product_id')::bigint
      AND COALESCE(ga.transfer_origin_id, ga.id) = p_from_address_id
  ) inv ON true
  LEFT JOIN LATERAL (
    SELECT sum(ti.qty) AS reserved
    FROM transfers t
    JOIN transfer_items ti ON ti.transfer_id = t.id AND ti.product_id = (x->>'product_id')::bigint
    JOIN receive_addresses tra ON tra.id = t.from_address_id
    WHERE COALESCE(tra.transfer_origin_id, tra.id) = p_from_address_id
      AND t.finalized_at IS NULL
      AND ((t.purchase_attempted_at IS NOT NULL AND t.purchase_attempted_at > now() - interval '30 days')
           OR (t.purchase_attempted_at IS NULL AND t.created_at > now() - interval '7 days'))
  ) res ON true;
  IF v_any_over AND NOT p_allow_over_onhand THEN RETURN; END IF;

  INSERT INTO transfers (from_address_id, from_label, from_address, destination_label, destination, parcel,
                         carrier, servicelevel, rate_amount, rate_currency, tracking_number, note, created_by,
                         finalized_at, direct_order_item_id, source_package_id, dest_receive_address_id)
  VALUES (v_addr.id, v_addr.label,
          jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                             'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                             'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email),
          TRIM(p_destination_label), p_destination, '{}'::jsonb,
          LOWER(TRIM(p_carrier)), NULL,
          NULLIF(TRIM(COALESCE(p_cost, '')), '')::numeric,
          CASE WHEN NULLIF(TRIM(COALESCE(p_cost, '')), '') IS NOT NULL THEN 'USD' END,
          v_tracking,
          NULLIF(TRIM(COALESCE(p_note, '')), ''), p_actor,
          now(), p_direct_order_item_id,
          v_src, v_dest)
  RETURNING transfers.id INTO v_id;

  INSERT INTO transfer_items (transfer_id, product_id, qty)
  SELECT v_id, (x->>'product_id')::bigint, (x->>'qty')::numeric
  FROM jsonb_array_elements(p_items) x;

  -- destination is one of OUR receive addresses: materialize the box as
  -- an INCOMING inbound package there (committed - trackable - and
  -- physically receivable on arrival). Guarded against an existing
  -- ACTIVE package on the same identity (partial unique index).
  IF v_dest IS NOT NULL THEN
    INSERT INTO inbound_packages (receive_address_id, carrier, tracking_number, note, created_by, committed_at)
    SELECT v_dest, LOWER(TRIM(p_carrier)), v_tracking,
           'Incoming transfer from ' || v_addr.label, p_actor, now()
    WHERE NOT EXISTS (
      SELECT 1 FROM inbound_packages x
      WHERE x.received_at IS NULL AND x.carrier = LOWER(TRIM(p_carrier))
        AND UPPER(x.tracking_number) = v_tracking)
    RETURNING inbound_packages.id INTO v_in;
    IF v_in IS NOT NULL THEN
      INSERT INTO inbound_package_items (package_id, product_id, qty)
      SELECT v_in, (x->>'product_id')::bigint, (x->>'qty')::numeric
      FROM jsonb_array_elements(p_items) x;
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      VALUES ('inbound_packages', v_in::text, 'package_created', p_actor,
              jsonb_build_object('receive_address_id', v_dest, 'carrier', LOWER(TRIM(p_carrier)),
                                 'tracking_number', v_tracking, 'from_transfer_id', v_id,
                                 'items', p_items));
    END IF;
  END IF;

  IF p_direct_order_item_id IS NOT NULL THEN
    -- stamp only when the CUMULATIVE finalized non-voided fills for this
    -- line (this transfer included — it is already inserted finalized)
    -- cover the ordered quantity, counting ONLY transfers sent to the
    -- order's CURRENT ship-to; the completing transfer owns the line
    UPDATE order_items oi
    SET direct_fulfilled_at = now(), direct_fulfilled_transfer_id = v_id
    FROM group_buy_products gbp3
    WHERE oi.id = p_direct_order_item_id
      AND gbp3.id = oi.group_buy_product_id
      AND (SELECT COALESCE(sum(ti.qty), 0)
           FROM transfers t4
           JOIN transfer_items ti ON ti.transfer_id = t4.id AND ti.product_id = gbp3.product_id
           JOIN orders o4 ON o4.id = oi.order_id
           WHERE t4.direct_order_item_id = p_direct_order_item_id
             AND t4.finalized_at IS NOT NULL
             AND COALESCE(t4.refund_status, '') <> 'SUCCESS'
             AND COALESCE(t4.destination->>'street1', '') = COALESCE(o4.address_line1, '')
             AND COALESCE(t4.destination->>'street2', '') = COALESCE(o4.address_line2, '')
             AND COALESCE(t4.destination->>'city', '')    = COALESCE(o4.city, '')
             AND COALESCE(t4.destination->>'state', '')   = COALESCE(o4.state_code, '')
             AND COALESCE(t4.destination->>'zip', '')     = COALESCE(o4.postal_code, ''))
          >= COALESCE(oi.qty_override, oi.qty);
    GET DIAGNOSTICS v_stamped = ROW_COUNT;
    IF v_stamped > 0 THEN
      UPDATE transfers tt SET direct_stamped_at = now() WHERE tt.id = v_id;
    END IF;
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    SELECT 'order_items', p_direct_order_item_id::text, 'direct_ship_label_attached', p_actor,
           jsonb_build_object('order_id', (SELECT oi2.order_id FROM order_items oi2 WHERE oi2.id = p_direct_order_item_id),
                              'transfer_id', v_id,
                              'carrier', LOWER(TRIM(p_carrier)),
                              'tracking_number', v_tracking,
                              'manual_label', true,
                              'completed', v_stamped > 0);
  END IF;

  INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
  VALUES ('transfers', v_id::text, 'manual_transfer_recorded', p_actor,
          jsonb_build_object('from_address_id', p_from_address_id, 'destination_label', TRIM(p_destination_label),
                             'carrier', LOWER(TRIM(p_carrier)),
                             'tracking_number', v_tracking,
                             'cost', NULLIF(TRIM(COALESCE(p_cost, '')), ''),
                             'items', p_items,
                             'over_onhand_override', v_any_over,
                             'direct_order_item_id', p_direct_order_item_id,
                             'group_buy_id', p_group_buy_id,
                             'direct_links_reclaimed', COALESCE(v_reclaimed, 0),
                             'source_package_id', v_src,
                             'dest_receive_address_id', v_dest,
                             'incoming_package_id', v_in));

  RETURN QUERY SELECT v_id::text;
END
$function$;
