import { action } from '@uibakery/data';

/**
 * Stamp upstream_reset_at AFTER resetVoidedShipmentUpstream verified the
 * ordering app no longer shows this box as shipped (or found nothing of
 * it there). Only a cancelled or refund-voided box, only once (the
 * 1790103200 trigger also refuses a live box and a re-stamp); a refusal
 * is zero rows. Until the stamp, the shipment card keeps "Reset ordering
 * app" and the Fulfillment row says the ordering app is not reset.
 * new_data records what the reset wrote (prior status, status set, dates
 * cleared, hand-typed dates left).
 */
function markShipmentUpstreamReset() {
  return action('markShipmentUpstreamReset', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE shipments s
        SET upstream_reset_at = now()
        WHERE s.id = {{params.shipment_id}}::bigint
          AND s.finalized_at IS NOT NULL
          AND (s.cancelled_at IS NOT NULL OR s.refund_status = 'SUCCESS')
          AND s.upstream_reset_at IS NULL
        RETURNING s.id, s.order_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'shipments', up.id::text, 'shipment_upstream_reset', {{params.actor}}::text,
             jsonb_build_object('order_id', up.order_id, 'reset', NULLIF({{params.reset}}::text, '')::jsonb)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default markShipmentUpstreamReset;
