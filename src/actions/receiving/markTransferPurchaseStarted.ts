import { action } from '@uibakery/data';

/**
 * Claim the PURCHASE LEASE on a draft right before a retry-purchase
 * POSTs to Shippo. EXCLUSIVE compare-and-swap: while another fresh lease
 * (<10 min) exists, the claim refuses — two admins racing retry-purchase
 * end with ONE Shippo POST, not two. ZERO ROWS back therefore means
 * either the draft no longer exists (deleted/finalized) or someone
 * else's purchase attempt is still fresh — the caller must ABORT before
 * any money moves. A definitive Shippo refusal clears the lease
 * (clearTransferPurchaseLease) so an honest retry needn't wait out the
 * window; ambiguous failures keep it, because money may have moved.
 * deleteTransferDraft refuses under the same fresh-lease rule. A draft
 * whose direct-ship link was RECLAIMED (expired reservation superseded
 * by a newer draft) refuses ALL claims permanently: a new label bought
 * against it would duplicate the shipment the new link-holder is
 * making. Recovery of an already-bought label bypasses this on purpose
 * (finalizeTransfer needs no claim), as does verified-no-label
 * deletion. Audited.
 */
function markTransferPurchaseStarted() {
  return action('markTransferPurchaseStarted', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      -- lck serializes this claim with reclaim (create_transfer_draft)
      -- on the SAME direct-line advisory lock: a reclaim cannot steal
      -- the line mid-claim (it waits here, then its per-statement
      -- snapshot sees our refreshed lease as FRESH and refuses), and a
      -- claim racing a just-committed reclaim re-reads the transfers
      -- row (EvalPlanQual) and sees direct_link_reclaimed_at. eligible
      -- ROW-LOCKS the order line AND its order (FOR UPDATE), so every
      -- gate is evaluated on the LATEST committed versions — serialized
      -- with concurrent order edits, not the statement's opening
      -- snapshot.
      WITH lck AS (
        SELECT t.id AS tid,
               CASE WHEN t.direct_order_item_id IS NOT NULL
                    THEN pg_advisory_xact_lock(hashtextextended('direct_line_' || t.direct_order_item_id::text, 42005))
               END AS locked
        FROM transfers t
        WHERE t.id = {{params.transfer_id}}::bigint
      ),
      -- LAST server gate before money moves: for a direct-linked draft
      -- the FULL draft-time eligibility must still hold — line
      -- outstanding, order active, not held, money collected, the
      -- stored destination still the order's CURRENT ship-to, the line
      -- still in its order's campaign (its own gbp fixes it), the
      -- transfer carrying SOME of the line's product, and the line not
      -- already fully covered by finalized fills. PARTIAL fills are
      -- legitimate (create_transfer_draft and finalizeTransfer both
      -- allow them; the line completes when the running total reaches
      -- the ordered qty) — this gate previously demanded the transfer
      -- alone cover the FULL effective quantity, which refused every
      -- Shippo purchase for a partially-filled line (Sheila Meyer
      -- 2026-09-02: 41 of 60 remaining, heartbeat returned zero rows).
      eligible AS (
        SELECT oi.id
        FROM lck
        JOIN transfers t ON t.id = lck.tid
        JOIN order_items oi ON oi.id = t.direct_order_item_id
        JOIN orders o ON o.id = oi.order_id
        JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
        LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
        WHERE oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL
          AND o.status NOT IN ('cancelled', 'refunded')
          AND NOT o.hold_shipping
          AND r.recon_status IN ('matched', 'over')
          AND r.pending_payment_count = 0
          AND COALESCE(t.destination->>'street1', '') = COALESCE(o.address_line1, '')
          AND COALESCE(t.destination->>'street2', '') = COALESCE(o.address_line2, '')
          AND COALESCE(t.destination->>'city', '')    = COALESCE(o.city, '')
          AND COALESCE(t.destination->>'state', '')   = COALESCE(o.state_code, '')
          AND COALESCE(t.destination->>'zip', '')     = COALESCE(o.postal_code, '')
          AND gbp.group_buy_id = o.group_buy_id
          AND EXISTS (
            SELECT 1 FROM transfer_items ti
            WHERE ti.transfer_id = t.id AND ti.product_id = gbp.product_id
              AND ti.qty > 0
          )
          -- cumulative finalized, non-voided, address-matched fills must
          -- still leave quantity unfilled — the same filled-sum shape
          -- create_transfer_draft evaluates at draft time
          AND (SELECT COALESCE(sum(ti5.qty), 0)
               FROM transfers t5
               JOIN transfer_items ti5 ON ti5.transfer_id = t5.id
               WHERE t5.direct_order_item_id = oi.id
                 AND t5.finalized_at IS NOT NULL
                 AND COALESCE(t5.refund_status, '') <> 'SUCCESS'
                 AND ti5.product_id = gbp.product_id
                 AND COALESCE(t5.destination->>'street1', '') = COALESCE(o.address_line1, '')
                 AND COALESCE(t5.destination->>'street2', '') = COALESCE(o.address_line2, '')
                 AND COALESCE(t5.destination->>'city', '')    = COALESCE(o.city, '')
                 AND COALESCE(t5.destination->>'state', '')   = COALESCE(o.state_code, '')
                 AND COALESCE(t5.destination->>'zip', '')     = COALESCE(o.postal_code, ''))
              < COALESCE(oi.qty_override, oi.qty)
        FOR UPDATE OF oi, o
      ),
      up AS (
        UPDATE transfers t
        -- purchase_attempted_at is the durable "a Shippo POST was actually
        -- dispatched after this" marker — it alone drives the long (30-day)
        -- inventory reservation; a draft that was merely created (tab died
        -- pre-POST) never gets it and stops reserving on the short window
        SET purchase_started_at = now(), purchase_attempted_at = now()
        WHERE t.id = (SELECT tid FROM lck)
          AND t.finalized_at IS NULL
          AND t.direct_link_reclaimed_at IS NULL
          AND (t.direct_order_item_id IS NULL OR EXISTS (SELECT 1 FROM eligible))
          -- exclusive CAS with an OWN-TOKEN refresh: the current holder
          -- (presenting its exact claimed_at) may re-stamp the lease as a
          -- pre-POST HEARTBEAT — a tab that slept past the window learns
          -- here (zero rows) that its draft was deleted or re-claimed and
          -- aborts BEFORE any money moves
          AND (t.purchase_started_at IS NULL
               OR t.purchase_started_at < now() - interval '10 minutes'
               OR ({{params.prior_claimed_at}}::text <> '' AND t.purchase_started_at = {{params.prior_claimed_at}}::timestamptz))
        RETURNING t.id, t.shippo_rate_id, t.purchase_started_at
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', up.id::text, 'transfer_purchase_claimed', {{params.actor}}::text,
             jsonb_build_object('shippo_rate_id', up.shippo_rate_id, 'claimed_at', up.purchase_started_at)
      FROM up
      -- claimed_at travels back to the caller: releasing the lease later
      -- requires presenting this exact value (compare-and-set), so a stale
      -- clear can never wipe a NEWER session's claim
      RETURNING row_pk AS id, (new_data->>'claimed_at') AS claimed_at
    `,
  });
}

export default markTransferPurchaseStarted;
