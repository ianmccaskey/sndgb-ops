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
 * deleteTransferDraft refuses under the same fresh-lease rule. Audited.
 */
function markTransferPurchaseStarted() {
  return action('markTransferPurchaseStarted', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET purchase_started_at = now()
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
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
