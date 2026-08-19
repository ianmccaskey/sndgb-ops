import { action } from '@uibakery/data';

/**
 * Vendors that actually SHIP PRODUCT — the only ones packages arrive
 * from, so the only ones the Receiving page offers. A vendor qualifies
 * when it is active and has at least one ACTIVE product line IN THE
 * SELECTED CAMPAIGN whose SKU is not COA (COA vendors send paperwork,
 * not boxes; a vendor with no lines in this buy — e.g. CHANGSHA-MIA —
 * never appears, even if it supplies some other campaign). JM is excluded by name per operator decision: niche vendor,
 * not part of regular receiving. Vendors already referenced by an
 * inbound package ALWAYS stay listed (even archived or line-closed
 * ones) so existing packages remain filterable after campaign state
 * changes — but the `shippable` flag separates them: only shippable
 * vendors may be picked for NEW packages; historical-only rows exist
 * for the dashboard filter and never re-enter the picker.
 */
function listShippingVendors() {
  return action('listShippingVendors', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH flags AS (
        SELECT v.id, v.code, v.active,
               (v.active
                AND UPPER(v.code) <> 'JM'
                AND EXISTS (
                  SELECT 1
                  FROM group_buy_products gbp
                  JOIN products p ON p.id = gbp.product_id
                  WHERE gbp.vendor_id = v.id
                    AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
                    AND gbp.status = 'active'
                    AND p.sku_code !~* '^coa'
                )) AS shippable,
               EXISTS (SELECT 1 FROM inbound_packages ip WHERE ip.vendor_id = v.id) AS referenced
        FROM vendors v
      )
      SELECT id, code, active, shippable
      FROM flags
      WHERE shippable OR referenced
      ORDER BY code
    `,
  });
}

export default listShippingVendors;
