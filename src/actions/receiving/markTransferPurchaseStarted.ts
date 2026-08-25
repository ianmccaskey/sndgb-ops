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
      WITH up AS (
        UPDATE transfers t
        -- purchase_attempted_at is the durable "a Shippo POST was actually
        -- dispatched after this" marker — it alone drives the long (30-day)
        -- inventory reservation; a draft that was merely created (tab died
        -- pre-POST) never gets it and stops reserving on the short window
        SET purchase_started_at = now(), purchase_attempted_at = now()
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
          AND t.direct_link_reclaimed_at IS NULL
          -- LAST server gate before money moves: for a direct-linked
          -- draft the FULL draft-time eligibility must still hold — line
          -- outstanding (not fulfilled/removed, still direct), order
          -- active, not held, money collected (matched/over, zero
          -- pending payments), the stored destination still the order's
          -- CURRENT ship-to, and the transfer still covering the line's
          -- current effective quantity. Any drift refuses the claim, so
          -- postage is never bought for an order that stopped being
          -- eligible. Same field/qty semantics as the draft-time checks.
          AND (t.direct_order_item_id IS NULL OR EXISTS (
            SELECT 1 FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
            LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
            WHERE oi.id = t.direct_order_item_id
              AND oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL
              AND o.status NOT IN ('cancelled', 'refunded')
              AND NOT o.hold_shipping
              AND r.recon_status IN ('matched', 'over')
              AND r.pending_payment_count = 0
              AND COALESCE(t.destination->>'street1', '') = COALESCE(o.address_line1, '')
              AND COALESCE(t.destination->>'street2', '') = COALESCE(o.address_line2, '')
              AND COALESCE(t.destination->>'city', '')    = COALESCE(o.city, '')
              AND COALESCE(t.destination->>'state', '')   = COALESCE(o.state_code, '')
              AND COALESCE(t.destination->>'zip', '')     = COALESCE(o.postal_code, '')
              AND EXISTS (
                SELECT 1 FROM transfer_items ti
                WHERE ti.transfer_id = t.id AND ti.product_id = gbp.product_id
                  AND ti.qty >= COALESCE(oi.qty_override, oi.qty)
              )
          ))
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
      SELECT 'transfers', up.id::text, 'transfer_purchase_claimed', {{params.actor}},
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
