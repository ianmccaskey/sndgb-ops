import { action } from '@uibakery/data';

/**
 * Claim the PURCHASE LEASE on a shipment draft right before a Shippo POST.
 * EXCLUSIVE compare-and-swap: while another fresh lease (<10 min) exists,
 * the claim refuses — two admins racing purchase end with ONE Shippo POST.
 * ZERO ROWS means the draft no longer exists/finalized, another session's
 * attempt is fresh, or the LAST server gate failed — the caller must
 * ABORT before any money moves. That last gate re-proves, on the
 * row-locked order: shippable status, not held, money still collected,
 * and the draft's stored ship-to snapshot still equal to the order's
 * CURRENT address (a correction since draft time must invalidate the
 * quote, not ship to the old address). Stamps purchase_attempted_at (the
 * durable "a POST was dispatched" marker) and re-nulls any stale
 * proof-of-absence — a new POST invalidates an old verified-no-label
 * walk. A definitive Shippo refusal clears the lease
 * (clearShipmentPurchaseLease); ambiguous failures keep it, because money
 * may have moved. Audited.
 */
function markShipmentPurchaseStarted() {
  return action('markShipmentPurchaseStarted', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT s.id AS sid, s.order_id AS oid,
               pg_advisory_xact_lock(42001, s.order_id::int) AS locked
        FROM shipments s
        WHERE s.id = {{params.shipment_id}}::bigint
      ),
      -- LAST server gate before money moves, on the LATEST committed rows
      -- (FOR UPDATE): every draft-time gate must still hold — including the
      -- SHIP-FROM: the draft's stored origin snapshot must still equal the
      -- live, still-active receive address (an origin corrected or archived
      -- after draft time must force a re-quote, not a label with a stale
      -- sender)
      eligible AS (
        SELECT o.id
        FROM lck
        JOIN shipments s ON s.id = lck.sid
        JOIN orders o ON o.id = s.order_id
        JOIN receive_addresses ra ON ra.id = s.ship_from_address_id
        LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
        WHERE o.status NOT IN ('cancelled', 'refunded')
          AND NOT o.hold_shipping
          AND r.recon_status IN ('matched', 'over')
          AND r.pending_payment_count = 0
          AND COALESCE(s.destination->>'street1', '') = COALESCE(o.address_line1, '')
          AND COALESCE(s.destination->>'street2', '') = COALESCE(o.address_line2, '')
          AND COALESCE(s.destination->>'city', '')    = COALESCE(o.city, '')
          AND COALESCE(s.destination->>'state', '')   = COALESCE(o.state_code, '')
          AND COALESCE(s.destination->>'zip', '')     = COALESCE(o.postal_code, '')
          AND ra.active
          AND jsonb_build_object('name', ra.name, 'street1', ra.street1, 'street2', ra.street2,
                                 'city', ra.city, 'state', ra.state, 'zip', ra.zip,
                                 'country', ra.country, 'phone', ra.phone, 'email', ra.email)
              = s.from_address
        FOR UPDATE OF o, ra
      ),
      up AS (
        UPDATE shipments s
        SET purchase_started_at = now(), purchase_attempted_at = now(),
            attempt_verified_no_label_at = NULL
        WHERE s.id = (SELECT sid FROM lck)
          AND s.finalized_at IS NULL
          AND EXISTS (SELECT 1 FROM eligible)
          -- exclusive CAS with an OWN-TOKEN refresh: the current holder
          -- (presenting its exact claimed_at) may re-stamp the lease as a
          -- pre-POST HEARTBEAT — a tab that slept past the window learns
          -- here (zero rows) that its draft was deleted or re-claimed and
          -- aborts BEFORE any money moves
          AND (s.purchase_started_at IS NULL
               OR s.purchase_started_at < now() - interval '10 minutes'
               OR ({{params.prior_claimed_at}}::text <> '' AND s.purchase_started_at = {{params.prior_claimed_at}}::timestamptz))
        RETURNING s.id, s.shippo_rate_id, s.purchase_started_at
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_purchase_claimed', {{params.actor}}::text,
             jsonb_build_object('shippo_rate_id', up.shippo_rate_id, 'claimed_at', up.purchase_started_at)
      FROM up
      -- claimed_at travels back to the caller: releasing the lease later
      -- requires presenting this exact value (compare-and-set), so a stale
      -- clear can never wipe a NEWER session's claim
      RETURNING row_pk AS id, (new_data->>'claimed_at') AS claimed_at
    `,
  });
}

export default markShipmentPurchaseStarted;
