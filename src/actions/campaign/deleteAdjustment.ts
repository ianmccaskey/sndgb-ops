import { action } from '@uibakery/data';

/**
 * Delete an adjustment. At-cost rows are refused (zero rows) when:
 *  - the payment was RECEIVED — deleting would erase a real customer
 *    payment's record along with the demand and the P&L waiver;
 *  - the product is VENDOR-COMMITTED (marked ordered, or any vendor
 *    payment is attributed to it) — the kits may already be bought, so
 *    silently dropping the demand would strand real vendor money as
 *    phantom over-payment and erase why the extra kits were procured.
 *    PREORDERED at-cost rows are exempt from this lock: they contribute
 *    no demand (the kits were bought outside demand), so deleting one
 *    just cancels the receivable expectation — the sale fell through.
 * Unreceived, uncommitted at-cost rows delete freely (the sale fell
 * through before anything real happened: demand, waiver, and receivable
 * all leave together). GB-priced adjustments delete as before.
 *
 * An OTHER-item row (1790102300, no product) has no demand and no kit
 * attribution to protect: it deletes unless its receivable was received
 * or a vendor payment row is attributed to it (1790102600) — that money
 * was recorded as paying for THIS item, so the payment batch has to go
 * first (the FK would refuse the delete too, less clearly). Money paid as
 * a lump is attributed to no item and does not lock it: the vendor's owed
 * figure drops and the Vendors page shows the over-payment, the truth.
 *
 * CAMPAIGN-SCOPED like every destructive action (a.group_buy_id now lives
 * on every row): a stale or forged id from another campaign must not
 * touch that campaign's demand or P&L — doubly important now that this is
 * the documented undo path for stock-plan commits. Audited with the full
 * removed row.
 */
function deleteAdjustment() {
  return action('deleteAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH del AS (
        DELETE FROM admin_adjustments a
        WHERE a.id = {{params.id}}::bigint
          AND a.group_buy_id = {{params.group_buy_id}}::bigint
          AND NOT (a.pricing = 'cost' AND a.received_at IS NOT NULL)
          AND NOT EXISTS (
                SELECT 1 FROM vendor_payments vp WHERE vp.admin_adjustment_id = a.id
              )
          AND NOT (a.pricing = 'cost' AND NOT a.preordered AND a.group_buy_product_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM group_buy_products gbp
                WHERE gbp.id = a.group_buy_product_id
                  AND (gbp.ordered_from_vendor_at IS NOT NULL
                       OR EXISTS (
                         SELECT 1 FROM vendor_payments vp
                         WHERE vp.group_buy_product_id = gbp.id
                       ))))
        RETURNING a.*
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
      SELECT 'admin_adjustments', del.id::text, 'adjustment_deleted', COALESCE(NULLIF({{params.actor}}::text, ''), 'operator'),
             to_jsonb(del.*)
      FROM del
      RETURNING row_pk AS id
    `,
  });
}

export default deleteAdjustment;
