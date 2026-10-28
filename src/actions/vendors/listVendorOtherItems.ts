import { action } from '@uibakery/data';

/**
 * The campaign's OTHER-item adjustments (1790102300) per vendor, for the
 * Vendors page: shown as rows under the vendor they are bought from and
 * offered as pickable lines in the payment form.
 *
 * paid_usd is what the vendor has been paid FOR THIS ITEM: the sum of the
 * payment rows attributed to it (vendor_payments.admin_adjustment_id,
 * 1790102600). Money paid as a lump "Other items $" line is attributed to
 * no item and shows at the vendor level only (v_vendor_balances
 * .other_paid_usd minus the items' sum).
 */
function listVendorOtherItems() {
  return action('listVendorOtherItems', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT a.id, a.vendor_id, v.code AS vendor_code,
             a.other_name, a.other_unit_cost_usd, a.qty, a.expected_usd,
             a.beneficiary, a.stock, a.received_at, a.reason, a.created_at,
             COALESCE((
               SELECT SUM(vp.amount_usd)
               FROM vendor_payments vp
               WHERE vp.admin_adjustment_id = a.id
             ), 0) AS paid_usd
      FROM admin_adjustments a
      JOIN vendors v ON v.id = a.vendor_id
      WHERE a.group_buy_id = {{params.group_buy_id}}::bigint
        AND a.group_buy_product_id IS NULL
      ORDER BY v.code, a.created_at
    `,
  });
}

export default listVendorOtherItems;
