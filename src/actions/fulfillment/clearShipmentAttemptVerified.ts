import { action } from '@uibakery/data';

/**
 * Stamp PROOF OF ABSENCE on a draft whose Shippo POST was dispatched but
 * whose outcome was ambiguous: the client just walked Shippo's transaction
 * listing by the draft's stored rate id (fail-closed pagination) and
 * proved NO label exists. attempt_verified_no_label_at unlocks
 * deleteShipmentDraft for this draft. COMPARE-AND-SET on the exact
 * purchase_attempted_at the walk was performed against — if a newer POST
 * was dispatched meanwhile, this stale proof refuses (and the claim path
 * re-nulls the stamp for the same reason). Audited.
 */
function clearShipmentAttemptVerified() {
  return action('clearShipmentAttemptVerified', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE shipments s
        SET attempt_verified_no_label_at = now()
        WHERE s.id = {{params.shipment_id}}::bigint
          AND s.finalized_at IS NULL
          AND s.purchase_attempted_at = {{params.observed_attempted_at}}::timestamptz
        RETURNING s.id, s.shippo_rate_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_attempt_verified_no_label', {{params.actor}}::text,
             jsonb_build_object('shippo_rate_id', up.shippo_rate_id)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default clearShipmentAttemptVerified;
