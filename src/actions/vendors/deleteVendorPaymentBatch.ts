import { action } from '@uibakery/data';

/**
 * Remove a mis-recorded vendor payment BATCH (1790102100) — every product
 * line, the freight row and every send go together (the DB refuses a
 * batch whose sends no longer equal its lines, so a single line can never
 * leave on its own). Delete + audit are one statement; the audit row
 * preserves the batch, its lines and its sends for reconstruction.
 *
 * Batched lines are written only by addVendorPaymentBatch and never carry
 * a stock-plan link; a batch holding one anyway is refused rather than
 * un-stamped blindly (deleteVendorPayment owns that path).
 */
function deleteVendorPaymentBatch() {
  return action('deleteVendorPaymentBatch', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH tgt AS (
        SELECT b.*
        FROM vendor_payment_batches b
        WHERE b.id = {{params.batch_id}}::bigint
          -- campaign-scoped like the list that displays it
          AND b.group_buy_id = {{params.group_buy_id}}::bigint
          AND NOT EXISTS (
            SELECT 1 FROM vendor_payments vp
            WHERE vp.batch_id = b.id AND vp.stock_plan_item_id IS NOT NULL
          )
      ), lines AS (
        SELECT to_jsonb(vp.*) AS j FROM vendor_payments vp, tgt WHERE vp.batch_id = tgt.id
      ), sends AS (
        SELECT to_jsonb(s.*) AS j FROM vendor_payment_sends s, tgt WHERE s.batch_id = tgt.id
      ), del AS (
        -- lines and sends cascade from the batch
        DELETE FROM vendor_payment_batches b
        USING tgt
        WHERE b.id = tgt.id
        RETURNING b.*
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
      SELECT 'vendor_payment_batches', del.id::text, 'vendor_payment_batch_deleted', {{params.actor}}::text,
             jsonb_build_object('batch', to_jsonb(del.*),
                                'lines', (SELECT jsonb_agg(j) FROM lines),
                                'sends', (SELECT jsonb_agg(j) FROM sends))
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteVendorPaymentBatch;
