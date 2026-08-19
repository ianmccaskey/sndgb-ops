import { action } from '@uibakery/data';

/**
 * Create a transfer DRAFT — BEFORE the label is purchased, so a failed or
 * interrupted purchase never leaves a paid label with no record, and the
 * inventory view (finalized_at IS NOT NULL) never moves on a draft. The
 * draft and ALL its item lines insert ATOMICALLY (items = jsonb array;
 * every line valid or nothing saves) — a purchased label must never
 * outlive an empty or partial item set. The chosen rate travels with the
 * draft; UNIQUE(shippo_rate_id) is the DB backstop against a
 * double-clicked purchase creating two rows. purchase_started_at stamps
 * the PURCHASE LEASE at birth: the purchase POST follows immediately, and
 * deleteTransferDraft refuses while the lease is fresh. Sending more than
 * is on hand refuses unless allow_over_onhand (the operator's explicit
 * confirmation) travels with the write — checked against LIVE inventory
 * here, and the override is audited. Audited.
 */
function createTransfer() {
  return action('createTransfer', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH input_items AS (
        SELECT (x->>'product_id')::bigint AS product_id, x->>'qty' AS qty_text
        FROM jsonb_array_elements({{params.items}}::jsonb) x
      ),
      ok AS (
        SELECT count(*) AS n,
               bool_and(qty_text ~ '^[0-9]+(\\.[0-9]{1,2})?$' AND qty_text::numeric > 0) AS all_valid
        FROM input_items
      ),
      -- over-on-hand is a SUPPORTED exception, but only as an EXPLICIT
      -- override: the server re-checks live inventory here, so a stale
      -- client or mis-keyed quantity refuses unless the operator confirmed.
      -- Unfinalized drafts count as RESERVATIONS (v_address_inventory only
      -- subtracts finalized transfers), so a second draft against the same
      -- stock sees the first one's quantities and needs its own override —
      -- competing drafts cannot each pass the check against the same boxes.
      -- Reservation expiry is STATE-AWARE: a draft whose purchase lease is
      -- held (possibly-paid — ambiguous failure or unfinalized label)
      -- reserves for 30 days so a delayed recovery cannot meet consumed
      -- stock; a lease-CLEARED draft (Shippo definitively refused — no
      -- charge, no label) reserves only while its rate could still be
      -- retried (~7 days, Shippo's rate lifetime). Both horizons keep a
      -- keyless stranded draft from holding stock hostage forever.
      over AS (
        SELECT COALESCE(bool_or(ii.qty_text::numeric > COALESCE(inv.on_hand_qty, 0) - COALESCE(res.reserved, 0)), false) AS any_over
        FROM input_items ii
        LEFT JOIN v_address_inventory inv
          ON inv.receive_address_id = {{params.from_address_id}}::bigint
         AND inv.product_id = ii.product_id
        LEFT JOIN LATERAL (
          SELECT sum(ti.qty) AS reserved
          FROM transfers t
          JOIN transfer_items ti ON ti.transfer_id = t.id AND ti.product_id = ii.product_id
          WHERE t.from_address_id = {{params.from_address_id}}::bigint
            AND t.finalized_at IS NULL
            -- a HELD lease measures its 30 days from the LEASE timestamp
            -- (a retry re-claim refreshes protection for the possibly-paid
            -- label); a CLEARED lease (definitive refusal) falls back to
            -- the draft's age and the rate's ~7-day retry window
            AND ((t.purchase_started_at IS NOT NULL AND t.purchase_started_at > now() - interval '30 days')
                 OR (t.purchase_started_at IS NULL AND t.created_at > now() - interval '7 days'))
        ) res ON true
      ),
      ins AS (
        INSERT INTO transfers (from_address_id, from_label, from_address, destination_label, destination, parcel, carrier, servicelevel, rate_amount, rate_currency, shippo_rate_id, note, created_by, purchase_started_at)
        SELECT ra.id,
               -- ship-from SNAPSHOT at draft time: editing the address later
               -- must not rewrite what the purchased label actually said
               ra.label,
               jsonb_build_object('name', ra.name, 'street1', ra.street1, 'street2', ra.street2,
                                  'city', ra.city, 'state', ra.state, 'zip', ra.zip,
                                  'country', ra.country, 'phone', ra.phone, 'email', ra.email),
               TRIM({{params.destination_label}}),
               {{params.destination}}::jsonb,
               {{params.parcel}}::jsonb,
               NULLIF({{params.carrier}}::text, ''),
               NULLIF({{params.servicelevel}}::text, ''),
               NULLIF({{params.rate_amount}}::text, '')::numeric,
               NULLIF({{params.rate_currency}}::text, ''),
               NULLIF({{params.shippo_rate_id}}::text, ''),
               NULLIF(TRIM({{params.note}}::text), ''),
               {{params.actor}},
               now()
        FROM receive_addresses ra
        WHERE ra.id = {{params.from_address_id}}::bigint
          -- archived addresses must not originate NEW labels — the archive
          -- toggle is authoritative on the money path
          AND ra.active
          -- the quote was priced for a specific ship-from: refuse if the
          -- address row was edited since (the client sends the contents it
          -- quoted with; jsonb equality is key-order independent)
          AND jsonb_build_object('name', ra.name, 'street1', ra.street1, 'street2', ra.street2,
                                 'city', ra.city, 'state', ra.state, 'zip', ra.zip,
                                 'country', ra.country, 'phone', ra.phone, 'email', ra.email)
              = {{params.expected_from}}::jsonb
          AND TRIM({{params.destination_label}}) <> ''
          AND NULLIF({{params.shippo_rate_id}}::text, '') IS NOT NULL
          AND (SELECT n > 0 AND all_valid FROM ok)
          AND (NOT (SELECT any_over FROM over) OR {{params.allow_over_onhand}}::boolean)
        RETURNING id, from_address_id, destination_label, carrier, servicelevel, rate_amount, purchase_started_at
      ),
      items_ins AS (
        INSERT INTO transfer_items (transfer_id, product_id, qty)
        SELECT ins.id, ii.product_id, ii.qty_text::numeric
        FROM ins, input_items ii
        RETURNING id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', ins.id::text, 'transfer_draft_created', {{params.actor}},
             jsonb_build_object('from_address_id', ins.from_address_id, 'destination_label', ins.destination_label,
                                'carrier', ins.carrier, 'servicelevel', ins.servicelevel, 'rate_amount', ins.rate_amount,
                                'items', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty_text)) FROM input_items),
                                'item_count', (SELECT count(*) FROM items_ins),
                                'over_onhand_override', (SELECT any_over FROM over),
                                'claimed_at', ins.purchase_started_at)
      FROM ins
      -- claimed_at (the birth purchase lease) travels back so a definitive
      -- Shippo refusal can release exactly THIS claim and no newer one
      RETURNING row_pk AS id, (new_data->>'claimed_at') AS claimed_at
    `,
  });
}

export default createTransfer;
