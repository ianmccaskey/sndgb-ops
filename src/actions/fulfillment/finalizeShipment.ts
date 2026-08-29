import { action } from '@uibakery/data';

/**
 * Record the purchased label onto its draft — the shipment becomes real:
 * status 'shipped', shipped_at + finalized_at stamped, label cost set from
 * the quoted rate. OWNERSHIP CHECK: params.rate_id is the rate the Shippo
 * transaction was actually purchased against (as reported by Shippo), and
 * the update refuses unless it equals the draft's stored shippo_rate_id —
 * a mismatched transaction from a stale client or bad retry can never
 * finalize the wrong draft. Retryable: a purchase-succeeded-but-
 * finalize-failed draft calls this again with the same transaction data;
 * the finalized guard makes a double-fire refuse harmlessly (and the
 * partial unique on shippo_transaction_id backstops a cross-draft
 * double-attach). RETURNS address_drift: recovery paths finalize WITHOUT
 * the pre-POST claim (the label already exists and must be recorded), so
 * a label bought before an address correction still lands — but the
 * caller surfaces the drift for remediation (refund/reship) instead of
 * pretending the box is headed to the right place. Audited.
 */
function finalizeShipment() {
  return action('finalizeShipment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        SELECT s.id AS sid, pg_advisory_xact_lock(42001, s.order_id::int) AS locked
        FROM shipments s
        WHERE s.id = {{params.shipment_id}}::bigint
      ),
      -- shared cross-path tracking lock (42006 'track_'): held until commit
      -- so a concurrent manual record's 120-day window check cannot run its
      -- dedupe scan before THIS finalize's row is visible — every finalized
      -- tracking writer (shipments and transfers, Shippo and manual) takes
      -- the same key. Ordered AFTER the 42001 order lock, matching
      -- create_manual_shipment (42001 -> 42006) — no inversion, no deadlock.
      tlck AS (
        SELECT pg_advisory_xact_lock(hashtextextended(
                 'track_' || regexp_replace(UPPER(COALESCE({{params.tracking_number}}::text, '')), '[^A-Z0-9]', '', 'g'),
                 42006)) AS locked
        FROM lck
      ),
      sel AS (
        SELECT s.id, s.order_id, s.rate_amount, s.destination
        FROM shipments s, lck, tlck
        WHERE s.id = lck.sid
          AND s.finalized_at IS NULL
          AND TRIM({{params.transaction_id}}::text) <> ''
          AND TRIM({{params.label_url}}::text) <> ''
          AND s.shippo_rate_id = TRIM({{params.rate_id}}::text)
        FOR UPDATE OF s
      ),
      up AS (
        UPDATE shipments s
        SET shippo_transaction_id = TRIM({{params.transaction_id}}::text),
            tracking_number = NULLIF({{params.tracking_number}}::text, ''),
            label_url = {{params.label_url}}::text,
            label_cost_usd = COALESCE(s.rate_amount, s.label_cost_usd),
            status = 'shipped',
            shipped_at = COALESCE(s.shipped_at, now()),
            finalized_at = now()
        FROM sel
        WHERE s.id = sel.id
        RETURNING s.id, s.order_id, s.shippo_transaction_id, s.tracking_number, s.label_url,
                  s.rate_amount, s.carrier, s.destination
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_finalized', {{params.actor}}::text,
             jsonb_build_object('order_id', up.order_id,
                                'shippo_transaction_id', up.shippo_transaction_id,
                                'tracking_number', up.tracking_number, 'label_url', up.label_url,
                                'rate_amount', up.rate_amount, 'carrier', up.carrier,
                                -- true = the order's address changed since this
                                -- draft snapshotted it (recovery finalize) —
                                -- the label may carry a stale destination
                                'address_drift', EXISTS (
                                  SELECT 1 FROM orders o
                                  WHERE o.id = up.order_id
                                    AND (COALESCE(up.destination->>'street1', '') <> COALESCE(o.address_line1, '')
                                      OR COALESCE(up.destination->>'street2', '') <> COALESCE(o.address_line2, '')
                                      OR COALESCE(up.destination->>'city', '')    <> COALESCE(o.city, '')
                                      OR COALESCE(up.destination->>'state', '')   <> COALESCE(o.state_code, '')
                                      OR COALESCE(up.destination->>'zip', '')     <> COALESCE(o.postal_code, ''))
                                ))
      FROM up
      RETURNING row_pk AS id, (new_data->>'address_drift') AS address_drift
    `,
  });
}

export default finalizeShipment;
