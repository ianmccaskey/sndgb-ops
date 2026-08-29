-- Review hardening, cross-path edition. Tracking-fingerprint exclusion is
-- now a SHARED invariant across every writer that can produce a finalized
-- tracking number (manual shipments, manual transfers, and — client-side,
-- in finalizeShipment/finalizeTransfer — the Shippo finalize paths): all
-- take the SAME transaction-scoped advisory lock, namespace 42006, key
-- 'track_' || <fingerprint>, before checking/writing. Concurrent writers
-- of one fingerprint serialize, so each window check sees the other's
-- committed row; legitimate reuse outside the 120-day recycling window
-- stays legal (what the dropped unique indexes could not express).
--
-- Also ports two fixes the NEW shipment fns already carry (1786473700)
-- back to the transfers fns, closing the same defects there:
--   * receive_addresses reads are FOR UPDATE (CAS content IS snapshot
--     content under concurrent address edits)
--   * transfers_manual_tracking_uniq dropped (global-forever uniqueness
--     contradicted the 120-day policy) — the 42006 lock replaces it
--   * create_manual_transfer's 120-day window check now ALSO scans
--     shipments (an order-shipment label retyped as a transfer must
--     refuse, symmetric with create_manual_shipment scanning transfers)
--   * create_manual_shipment re-created with the shared 'track_' key
--     (was 'ship_track_' — a private key cannot serialize cross-path)
--
-- All function texts below are exactly what was executed live.
DROP INDEX transfers_manual_tracking_uniq;

CREATE OR REPLACE FUNCTION create_transfer_draft(
  p_from_address_id bigint, p_destination_label text, p_destination jsonb, p_parcel jsonb,
  p_carrier text, p_servicelevel text, p_rate_amount text, p_rate_currency text,
  p_shippo_rate_id text, p_items jsonb, p_allow_over_onhand boolean, p_expected_from jsonb,
  p_destination_id bigint, p_expected_destination jsonb, p_note text, p_actor text,
  p_direct_order_item_id bigint, p_group_buy_id bigint
) RETURNS TABLE (id text, claimed_at text)
LANGUAGE plpgsql VOLATILE AS $fn$
-- identical to the previously live definition except the receive_addresses
-- read is FOR UPDATE (see header); body kept in full per house convention
DECLARE
  v_addr receive_addresses%ROWTYPE;
  v_n int;
  v_all_valid boolean;
  v_any_over boolean;
  v_id bigint;
  v_claimed timestamptz;
  v_reclaimed bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(42004, p_from_address_id::int);
  IF p_direct_order_item_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('direct_line_' || p_direct_order_item_id::text, 42005));
  END IF;

  SELECT * INTO v_addr FROM receive_addresses ra
  WHERE ra.id = p_from_address_id AND ra.active
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

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

  SELECT count(*), bool_and(x->>'qty' ~ '^[0-9]+(\.[0-9]{1,2})?$' AND (x->>'qty')::numeric > 0)
  INTO v_n, v_all_valid
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR NOT COALESCE(v_all_valid, false) THEN RETURN; END IF;

  IF p_direct_order_item_id IS NOT NULL THEN
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
          AND (x->>'qty')::numeric >= COALESCE(oi.qty_override, oi.qty)
      )
    FOR UPDATE OF oi, o;
    IF NOT FOUND THEN RETURN; END IF;
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
  LEFT JOIN v_address_inventory inv
    ON inv.receive_address_id = p_from_address_id AND inv.product_id = (x->>'product_id')::bigint
  LEFT JOIN LATERAL (
    SELECT sum(ti.qty) AS reserved
    FROM transfers t
    JOIN transfer_items ti ON ti.transfer_id = t.id AND ti.product_id = (x->>'product_id')::bigint
    WHERE t.from_address_id = p_from_address_id
      AND t.finalized_at IS NULL
      AND ((t.purchase_attempted_at IS NOT NULL AND t.purchase_attempted_at > now() - interval '30 days')
           OR (t.purchase_attempted_at IS NULL AND t.created_at > now() - interval '7 days'))
  ) res ON true;
  IF v_any_over AND NOT p_allow_over_onhand THEN RETURN; END IF;

  INSERT INTO transfers (from_address_id, from_label, from_address, destination_label, destination, parcel,
                         carrier, servicelevel, rate_amount, rate_currency, shippo_rate_id, note, created_by,
                         purchase_started_at, direct_order_item_id)
  VALUES (v_addr.id, v_addr.label,
          jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                             'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                             'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email),
          TRIM(p_destination_label), p_destination, p_parcel,
          NULLIF(p_carrier, ''), NULLIF(p_servicelevel, ''), NULLIF(p_rate_amount, '')::numeric,
          NULLIF(p_rate_currency, ''), NULLIF(p_shippo_rate_id, ''),
          NULLIF(TRIM(COALESCE(p_note, '')), ''), p_actor, now(), p_direct_order_item_id)
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
                             'claimed_at', v_claimed));

  RETURN QUERY SELECT v_id::text, (jsonb_build_object('c', v_claimed)->>'c');
END
$fn$;

CREATE OR REPLACE FUNCTION create_manual_transfer(
  p_from_address_id bigint, p_destination_label text, p_destination jsonb,
  p_carrier text, p_tracking_number text, p_cost text, p_items jsonb,
  p_allow_over_onhand boolean, p_expected_from jsonb, p_destination_id bigint,
  p_expected_destination jsonb, p_note text, p_actor text,
  p_direct_order_item_id bigint, p_group_buy_id bigint
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
-- changes vs 1786473200: FOR UPDATE address read; shared 'track_' 42006
-- advisory lock before the dedupe; window check also scans shipments
DECLARE
  v_addr receive_addresses%ROWTYPE;
  v_n int;
  v_all_valid boolean;
  v_any_over boolean;
  v_id bigint;
  v_reclaimed bigint;
  v_tracking text;
BEGIN
  PERFORM pg_advisory_xact_lock(42004, p_from_address_id::int);
  IF p_direct_order_item_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('direct_line_' || p_direct_order_item_id::text, 42005));
  END IF;

  SELECT * INTO v_addr FROM receive_addresses ra
  WHERE ra.id = p_from_address_id AND ra.active
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

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

  -- shared cross-path race backstop (see migration header)
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

  SELECT count(*), bool_and(x->>'qty' ~ '^[0-9]+(\.[0-9]{1,2})?$' AND (x->>'qty')::numeric > 0)
  INTO v_n, v_all_valid
  FROM jsonb_array_elements(p_items) x;
  IF COALESCE(v_n, 0) = 0 OR NOT COALESCE(v_all_valid, false) THEN RETURN; END IF;

  IF p_direct_order_item_id IS NOT NULL THEN
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
          AND (x->>'qty')::numeric >= COALESCE(oi.qty_override, oi.qty)
      )
    FOR UPDATE OF oi, o;
    IF NOT FOUND THEN RETURN; END IF;
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
  LEFT JOIN v_address_inventory inv
    ON inv.receive_address_id = p_from_address_id AND inv.product_id = (x->>'product_id')::bigint
  LEFT JOIN LATERAL (
    SELECT sum(ti.qty) AS reserved
    FROM transfers t
    JOIN transfer_items ti ON ti.transfer_id = t.id AND ti.product_id = (x->>'product_id')::bigint
    WHERE t.from_address_id = p_from_address_id
      AND t.finalized_at IS NULL
      AND ((t.purchase_attempted_at IS NOT NULL AND t.purchase_attempted_at > now() - interval '30 days')
           OR (t.purchase_attempted_at IS NULL AND t.created_at > now() - interval '7 days'))
  ) res ON true;
  IF v_any_over AND NOT p_allow_over_onhand THEN RETURN; END IF;

  INSERT INTO transfers (from_address_id, from_label, from_address, destination_label, destination, parcel,
                         carrier, servicelevel, rate_amount, rate_currency, tracking_number, note, created_by,
                         finalized_at, direct_order_item_id, direct_stamped_at)
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
          CASE WHEN p_direct_order_item_id IS NOT NULL THEN now() END)
  RETURNING transfers.id INTO v_id;

  INSERT INTO transfer_items (transfer_id, product_id, qty)
  SELECT v_id, (x->>'product_id')::bigint, (x->>'qty')::numeric
  FROM jsonb_array_elements(p_items) x;

  IF p_direct_order_item_id IS NOT NULL THEN
    UPDATE order_items oi
    SET direct_fulfilled_at = now(), direct_fulfilled_transfer_id = v_id
    WHERE oi.id = p_direct_order_item_id;
    INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
    SELECT 'order_items', p_direct_order_item_id::text, 'direct_ship_label_attached', p_actor,
           jsonb_build_object('order_id', (SELECT oi2.order_id FROM order_items oi2 WHERE oi2.id = p_direct_order_item_id),
                              'transfer_id', v_id,
                              'carrier', LOWER(TRIM(p_carrier)),
                              'tracking_number', v_tracking,
                              'manual_label', true);
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
                             'direct_links_reclaimed', COALESCE(v_reclaimed, 0)));

  RETURN QUERY SELECT v_id::text;
END
$fn$;

-- create_manual_shipment re-created ONLY to move its advisory-lock key to
-- the shared 'track_' namespace (was 'ship_track_' — a private key cannot
-- serialize against the transfer writers above). Body otherwise identical
-- to 1786473700.
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
