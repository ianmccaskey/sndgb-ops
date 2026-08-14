import { action } from '@uibakery/data';

/**
 * What we still owe each vendor for NON-COA products — the "real product
 * money" the wallets must cover. Per vendor:
 *   demand = non-COA product cost owed (final counts) + those products'
 *            freight (only once a product has kits to buy)
 *   paid   = every payment to the vendor EXCEPT ones attributed to a COA
 *            product (freight/unattributed rows are vendor-level money and
 *            count here; COA-attributed payments belong to the COA ledger)
 *   owed   = GREATEST(demand − paid, 0), clamped PER VENDOR so one vendor's
 *            over-payment can never hide another vendor's open balance.
 */
function listNonCoaVendorOwed() {
  return action('listNonCoaVendorOwed', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH prod AS (
        SELECT pp.vendor_code,
               COALESCE(SUM(pp.owed_to_vendor_usd + CASE WHEN pp.final_count > 0 THEN pp.freight_usd ELSE 0 END)
                 FILTER (WHERE pp.sku_code NOT ILIKE 'COA%'), 0) AS noncoa_demand_usd
        FROM v_product_profit pp
        WHERE pp.group_buy_id = {{params.group_buy_id}}::bigint
        GROUP BY pp.vendor_code
      ), pay AS (
        SELECT v.code AS vendor_code,
               COALESCE(SUM(vp.amount_usd), 0) AS paid_usd,
               COALESCE(SUM(vp.amount_usd) FILTER (WHERE pr.sku_code ILIKE 'COA%'), 0) AS paid_coa_usd
        FROM vendor_payments vp
        JOIN vendors v ON v.id = vp.vendor_id
        LEFT JOIN group_buy_products gbp ON gbp.id = vp.group_buy_product_id
        LEFT JOIN products pr ON pr.id = gbp.product_id
        WHERE vp.group_buy_id = {{params.group_buy_id}}::bigint
        GROUP BY v.code
      )
      SELECT prod.vendor_code,
             ROUND(prod.noncoa_demand_usd, 2) AS demand_usd,
             ROUND(COALESCE(pay.paid_usd, 0) - COALESCE(pay.paid_coa_usd, 0), 2) AS paid_usd,
             ROUND(GREATEST(prod.noncoa_demand_usd - (COALESCE(pay.paid_usd, 0) - COALESCE(pay.paid_coa_usd, 0)), 0), 2) AS owed_usd
      FROM prod
      LEFT JOIN pay ON pay.vendor_code = prod.vendor_code
      WHERE prod.noncoa_demand_usd > 0
      ORDER BY owed_usd DESC, prod.vendor_code
    `,
  });
}

export default listNonCoaVendorOwed;
