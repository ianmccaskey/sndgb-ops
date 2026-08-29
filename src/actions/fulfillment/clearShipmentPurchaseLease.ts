import { action } from '@uibakery/data';

/**
 * Release the PURCHASE LEASE after Shippo DEFINITIVELY refused the label
 * (ERROR-status transaction — no charge, no label). Only that path calls
 * this: ambiguous failures (network drop, 5xx, poll timeout) keep the
 * lease, because money may have moved and the draft must stay undeletable
 * until verified. COMPARE-AND-SET on the exact claimed_at — a delayed
 * clear from an old refused attempt cannot wipe a lease another session
 * has since re-claimed. Audited.
 */
function clearShipmentPurchaseLease() {
  return action('clearShipmentPurchaseLease', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE shipments s
        -- a definitive refusal proves no charge: both the lease AND the
        -- attempted marker clear
        SET purchase_started_at = NULL, purchase_attempted_at = NULL
        WHERE s.id = {{params.shipment_id}}::bigint
          AND s.finalized_at IS NULL
          AND s.purchase_started_at = {{params.claimed_at}}::timestamptz
        RETURNING s.id, s.shippo_rate_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_purchase_lease_cleared', {{params.actor}}::text,
             jsonb_build_object('shippo_rate_id', up.shippo_rate_id, 'reason', 'shippo_refused')
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default clearShipmentPurchaseLease;
