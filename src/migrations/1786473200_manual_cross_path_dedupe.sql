-- Review hardening on 1786473100: the manual-label dedupe must also
-- see SHIPPO-bought transfers. The manual-only unique index compares
-- manual rows to manual rows, so a label purchased THROUGH the app
-- could still be re-recorded manually (ambiguous-timeout retype, or an
-- operator recording a label the other admin already bought here).
-- create_manual_transfer now refuses when ANY finalized transfer —
-- Shippo or manual — carries the same normalized tracking fingerprint
-- within the last 120 days (the carrier number-recycling window, the
-- same rationale as the inbound-package active-uniqueness index; a
-- genuinely recycled number older than that may be recorded). A hard
-- global unique index was deliberately NOT used: USPS recycles numbers
-- after ~120 days, so an unconditional cross-era constraint could
-- wrongly block a legitimate reuse with no override; the fn-level
-- window check is exact. The manual-only index stays as the in-window
-- race backstop for manual-vs-manual (the Shippo path cannot race this
-- check in practice — a Shippo tracking number only exists after its
-- finalize has committed).
--
-- create_manual_transfer re-created (same signature, CREATE OR
-- REPLACE) with the cross-path refusal added right after tracking
-- normalization. Full text — exactly what was executed live (verified
-- via pg_get_functiondef containing the 120-day check).
CREATE OR REPLACE FUNCTION create_manual_transfer(
  p_from_address_id bigint,
  p_destination_label text,
  p_destination jsonb,
  p_carrier text,
  p_tracking_number text,
  p_cost text,
  p_items jsonb,
  p_allow_over_onhand boolean,
  p_expected_from jsonb,
  p_destination_id bigint,
  p_expected_destination jsonb,
  p_note text,
  p_actor text,
  p_direct_order_item_id bigint,
  p_group_buy_id bigint
) RETURNS TABLE (id text)
LANGUAGE plpgsql VOLATILE AS $fn$
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
  WHERE ra.id = p_from_address_id AND ra.active;
  IF NOT FOUND THEN RETURN; END IF;

  IF jsonb_build_object('name', v_addr.name, 'street1', v_addr.street1, 'street2', v_addr.street2,
                        'city', v_addr.city, 'state', v_addr.state, 'zip', v_addr.zip,
                        'country', v_addr.country, 'phone', v_addr.phone, 'email', v_addr.email)
     IS DISTINCT FROM p_expected_from THEN RETURN; END IF;

  -- canonical COMPACT tracking: UPPER + all whitespace removed
  -- (receipts print grouped digits; whitespace is never part of a
  -- tracking number) — the unique fingerprint index additionally
  -- collapses hyphens/dots
  v_tracking := regexp_replace(UPPER(TRIM(COALESCE(p_tracking_number, ''))), '\s', '', 'g');

  IF TRIM(COALESCE(p_destination_label, '')) = ''
     OR TRIM(COALESCE(p_carrier, '')) = ''
     OR v_tracking = '' THEN RETURN; END IF;
  IF NULLIF(TRIM(COALESCE(p_cost, '')), '') IS NOT NULL
     AND NOT (TRIM(p_cost) ~ '^[0-9]+(\.[0-9]{1,2})?$' AND TRIM(p_cost)::numeric > 0) THEN RETURN; END IF;

  -- CROSS-PATH duplicate refusal: this label may already be recorded as
  -- a SHIPPO-bought transfer (the manual-only unique index cannot see
  -- those). Any finalized transfer with the same normalized tracking
  -- fingerprint within the carrier number-recycling window (120 days —
  -- the same rationale as the inbound-package active-uniqueness) means
  -- this manual record would duplicate an existing shipment: refuse.
  IF EXISTS (
    SELECT 1 FROM transfers t3
    WHERE t3.finalized_at IS NOT NULL
      AND t3.finalized_at > now() - interval '120 days'
      AND t3.tracking_number IS NOT NULL
      AND regexp_replace(UPPER(t3.tracking_number), '[^A-Z0-9]', '', 'g')
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
