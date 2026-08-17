import { action } from '@uibakery/data';

/**
 * Delete an adjustment. At-cost rows are refused (zero rows) when:
 *  - the payment was RECEIVED — deleting would erase a real customer
 *    payment's record along with the demand and the P&L waiver;
 *  - the product is VENDOR-COMMITTED (marked ordered, or any vendor
 *    payment is attributed to it) — the kits may already be bought, so
 *    silently dropping the demand would strand real vendor money as
 *    phantom over-payment and erase why the extra kits were procured.
 * Unreceived, uncommitted at-cost rows delete freely (the sale fell
 * through before anything real happened: demand, waiver, and receivable
 * all leave together). GB-priced adjustments delete as before.
 */
function deleteAdjustment() {
  return action('deleteAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      DELETE FROM admin_adjustments a
      USING group_buy_products gbp
      WHERE a.id = {{params.id}}::bigint
        AND gbp.id = a.group_buy_product_id
        AND NOT (a.pricing = 'cost' AND a.received_at IS NOT NULL)
        AND NOT (a.pricing = 'cost' AND (
              gbp.ordered_from_vendor_at IS NOT NULL
              OR EXISTS (
                SELECT 1 FROM vendor_payments vp
                WHERE vp.group_buy_product_id = gbp.id
              )))
      RETURNING a.id
    `,
  });
}

export default deleteAdjustment;
