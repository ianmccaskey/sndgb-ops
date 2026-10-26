import { action } from '@uibakery/data';

/**
 * The campaign's OTHER-item adjustments (1790102300) per vendor, for the
 * Vendors page: shown as rows under the vendor they are bought from and
 * offered as pickable lines in the payment form. Paid-ness is tracked at
 * the vendor level (v_vendor_balances.other_paid_usd), not per item — a
 * payment's Other-items line carries no item attribution.
 */
function listVendorOtherItems() {
  return action('listVendorOtherItems', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT a.id, a.vendor_id, v.code AS vendor_code,
             a.other_name, a.other_unit_cost_usd, a.qty, a.expected_usd,
             a.beneficiary, a.stock, a.received_at, a.reason, a.created_at
      FROM admin_adjustments a
      JOIN vendors v ON v.id = a.vendor_id
      WHERE a.group_buy_id = {{params.group_buy_id}}::bigint
        AND a.group_buy_product_id IS NULL
      ORDER BY v.code, a.created_at
    `,
  });
}

export default listVendorOtherItems;
