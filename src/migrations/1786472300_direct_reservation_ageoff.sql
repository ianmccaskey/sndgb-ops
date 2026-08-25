-- Review hardening on 1786472200, three fixes in one function revision.
--
-- (1) AGE-OFF: the direct-line reservation now expires under the SAME
-- windows as the inventory reservation (purchase actually attempted =>
-- 30 days on purchase_attempted_at; never attempted => 7 days, the
-- rate lifetime, on created_at). A fresh reservation still refuses a
-- second draft; an EXPIRED one is RECLAIMED — the stale draft's
-- direct_order_item_id is set NULL (audited 'direct_link_reclaimed')
-- and the new draft takes the link. Reclaim is race-safe: it runs
-- under the 42005 line lock, and the partial unique index remains the
-- backstop for writers that never took the lock. A reclaimed zombie
-- draft can still be finalized later (its label may really have been
-- bought) — it just no longer stamps the order line (direct_stamped=0
-- surfaces that), while the NEW link-holder stamps when it finalizes.
-- One abandoned draft can no longer block a customer's line forever.
--
-- (2) BIGINT-SAFE LOCK: the 42005 lock key was p_direct_order_item_id
-- ::int, which overflows once order_items.id passes 2^31. Now
-- hashtextextended('direct_line_' || id, 42005) — a stable bigint key
-- in the single-key advisory space (locktag field4 differs from the
-- two-int form, so it cannot collide with the 42001/42004 locks).
--
-- (3) INDEX PREFLIGHT (documentation of fact + replay guard): at the
-- moment 1786472200's unique index was created live, transfers had
-- ZERO non-null direct_order_item_id rows (verified by query — the UI
-- for linked drafts had never been released), so the index build could
-- not have hit duplicates. The DO block below is a replay guard for
-- any copy of this database where that is not true: it fails fast with
-- instructions instead of leaving a half-applied deploy.

DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM transfers
    WHERE direct_order_item_id IS NOT NULL AND finalized_at IS NULL
    GROUP BY direct_order_item_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate unfinalized direct_order_item_id links exist — resolve them (keep one draft per line, NULL the others'' direct_order_item_id) before this migration';
  END IF;
END
$chk$;

-- Full text — exactly what was executed live (verified via
-- pg_get_functiondef containing hashtextextended and the reclaim CTE).
CREATE OR REPLACE FUNCTION create_transfer_draft(
  p_from_address_id bigint,
  p_destination_label text,
  p_destination jsonb,
  p_parcel jsonb,
  p_carrier text,
  p_servicelevel text,
  p_rate_amount text,
  p_rate_currency text,
  p_shippo_rate_id text,
  p_items jsonb,
  p_allow_over_onhand boolean,
  p_expected_from jsonb,
  p_destination_id bigint,
  p_expected_destination jsonb,
  p_note text,
  p_actor text,
  p_direct_order_item_id bigint,
  p_group_buy_id bigint
) RETURNS TABLE (id text, claimed_at text)
LANGUAGE plpgsql VOLATILE AS $fn$
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
  -- serialize on the direct line too — bigint-safe key; concurrent
  -- drafts for the same order line (possibly from DIFFERENT ship-from
  -- addresses, which the 42004 lock never sees) validate one at a time
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

  -- linked direct-ship line: live, outstanding, money-gated,
  -- campaign-bound, ship-to present, product on this transfer
  IF p_direct_order_item_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      WHERE oi.id = p_direct_order_item_id
        AND oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL
        AND o.status NOT IN ('cancelled', 'refunded')
        AND o.group_buy_id = p_group_buy_id
        AND NOT o.hold_shipping
        AND r.recon_status IN ('matched', 'over')
        AND r.pending_payment_count = 0
        AND COALESCE(o.address_line1, '') <> ''
        AND gbp.product_id IN (SELECT (x->>'product_id')::bigint FROM jsonb_array_elements(p_items) x)
    ) THEN RETURN; END IF;
    -- a FRESH unfinalized link (same windows as the inventory
    -- reservation) refuses this draft; an EXPIRED one is reclaimed
    IF EXISTS (
      SELECT 1 FROM transfers t2
      WHERE t2.direct_order_item_id = p_direct_order_item_id AND t2.finalized_at IS NULL
        AND ((t2.purchase_attempted_at IS NOT NULL AND t2.purchase_attempted_at > now() - interval '30 days')
             OR (t2.purchase_attempted_at IS NULL AND t2.created_at > now() - interval '7 days'))
    ) THEN RETURN; END IF;
    WITH gone AS (
      UPDATE transfers t2 SET direct_order_item_id = NULL
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
