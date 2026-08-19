import { action } from '@uibakery/data';

/**
 * Vendors that actually SHIP PRODUCT — the only ones packages arrive
 * from, so the only ones the Receiving page offers. A vendor qualifies
 * when it is active and has at least one ACTIVE campaign product line
 * whose SKU is not COA (COA vendors send paperwork, not boxes; a vendor
 * with no lines in any live campaign — e.g. CHANGSHA-MIA — never
 * appears). JM is excluded by name per operator decision: niche vendor,
 * not part of regular receiving.
 */
function listShippingVendors() {
  return action('listShippingVendors', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT v.id, v.code, v.active
      FROM vendors v
      WHERE v.active
        AND UPPER(v.code) <> 'JM'
        AND EXISTS (
          SELECT 1
          FROM group_buy_products gbp
          JOIN products p ON p.id = gbp.product_id
          WHERE gbp.vendor_id = v.id
            AND gbp.status = 'active'
            AND p.sku_code !~* '^coa'
        )
      ORDER BY v.code
    `,
  });
}

export default listShippingVendors;
