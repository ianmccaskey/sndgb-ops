import { action } from '@uibakery/data';

/**
 * What we still owe each vendor for NON-COA products — the "real product
 * money" the wallets must cover. Spans ALL campaigns deliberately: the
 * wallets are one global pool, so the owed side must cover everything the
 * pool is on the hook for, not just the campaign currently selected.
 * Per vendor and campaign:
 *   demand = non-COA product cost owed (final counts) + those products'
 *            freight (a per-kit rate × final count)
 *   paid   = every payment to the vendor EXCEPT ones attributed to a COA
 *            product (freight/unattributed rows are vendor-level money and
 *            count here; COA-attributed payments belong to the COA ledger)
 *   owed   = GREATEST(demand − paid, 0), clamped per vendor AND campaign so
 *            an over-payment in one place can never hide an open balance in
 *            another; a fully-paid old campaign contributes 0.
 */
function listNonCoaVendorOwed() {
  return action('listNonCoaVendorOwed', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH prod AS (
        SELECT pp.vendor_code, pp.group_buy_id,
               -- final_count can go negative via admin adjustments — a negative
               -- count must contribute zero freight, never a negative liability
               COALESCE(SUM(pp.owed_to_vendor_usd + CASE WHEN pp.final_count > 0 THEN pp.freight_usd * pp.final_count ELSE 0 END)
                 FILTER (WHERE pp.sku_code NOT ILIKE 'COA%'), 0) AS noncoa_demand_usd
        FROM v_product_profit pp
        GROUP BY pp.vendor_code, pp.group_buy_id
      ), dfr AS (
        -- direct-ship freight (per-box, internal) is vendor money too
        SELECT vendor_code, group_buy_id, SUM(direct_freight_usd) AS direct_usd
        FROM v_direct_freight
        WHERE sku_code NOT ILIKE 'COA%'
        GROUP BY vendor_code, group_buy_id
      ), pay AS (
        SELECT v.code AS vendor_code, vp.group_buy_id,
               COALESCE(SUM(vp.amount_usd), 0) AS paid_usd,
               COALESCE(SUM(vp.amount_usd) FILTER (WHERE pr.sku_code ILIKE 'COA%'), 0) AS paid_coa_usd
        FROM vendor_payments vp
        JOIN vendors v ON v.id = vp.vendor_id
        LEFT JOIN group_buy_products gbp ON gbp.id = vp.group_buy_product_id
        LEFT JOIN products pr ON pr.id = gbp.product_id
        GROUP BY v.code, vp.group_buy_id
      ), per AS (
        SELECT prod.vendor_code,
               prod.noncoa_demand_usd + COALESCE(dfr.direct_usd, 0) AS noncoa_demand_usd,
               COALESCE(pay.paid_usd, 0) - COALESCE(pay.paid_coa_usd, 0) AS noncoa_paid_usd,
               GREATEST(prod.noncoa_demand_usd + COALESCE(dfr.direct_usd, 0) - (COALESCE(pay.paid_usd, 0) - COALESCE(pay.paid_coa_usd, 0)), 0) AS owed_usd
        FROM prod
        LEFT JOIN pay ON pay.vendor_code = prod.vendor_code AND pay.group_buy_id = prod.group_buy_id
        LEFT JOIN dfr ON dfr.vendor_code = prod.vendor_code AND dfr.group_buy_id = prod.group_buy_id
      )
      SELECT vendor_code,
             ROUND(SUM(noncoa_demand_usd), 2) AS demand_usd,
             ROUND(SUM(noncoa_paid_usd), 2) AS paid_usd,
             ROUND(SUM(owed_usd), 2) AS owed_usd
      FROM per
      GROUP BY vendor_code
      HAVING SUM(owed_usd) > 0
      ORDER BY SUM(owed_usd) DESC, vendor_code
    `,
  });
}

export default listNonCoaVendorOwed;
