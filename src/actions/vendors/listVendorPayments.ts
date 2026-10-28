import { action } from '@uibakery/data';

/**
 * Payment log rows: one per vendor_payments line. A line recorded as part
 * of a batch (1790102100) carries batch_id and the batch's sends (every
 * line of the batch repeats the same `sends` array; the page groups by
 * batch_id and shows them once). An unbatched line is its own single send
 * from wallet_name. Ordered so a batch's lines stay contiguous.
 */
function listVendorPayments() {
  return action('listVendorPayments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT vp.id, vp.paid_on, vp.amount_usd, vp.kits_qty, vp.freight_usd, vp.method, vp.receipt_ref, vp.note,
             vp.batch_id,
             v.code AS vendor_code, w.name AS wallet_name, p.sku_code,
             -- an Other-items line attributed to one item (1790102600)
             vp.admin_adjustment_id, oa.other_name,
             bs.sends
      FROM vendor_payments vp
      JOIN vendors v ON v.id = vp.vendor_id
      LEFT JOIN wallets w ON w.id = vp.wallet_id
      LEFT JOIN group_buy_products gbp ON gbp.id = vp.group_buy_product_id
      LEFT JOIN products p ON p.id = gbp.product_id
      LEFT JOIN admin_adjustments oa ON oa.id = vp.admin_adjustment_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id', s.id, 'wallet_name', sw.name, 'chain', sw.chain,
                                            'amount_usd', s.amount_usd, 'method', s.method, 'tx_ref', s.tx_ref)
                         ORDER BY s.id) AS sends
        FROM vendor_payment_sends s
        JOIN wallets sw ON sw.id = s.wallet_id
        WHERE s.batch_id = vp.batch_id
      ) bs ON vp.batch_id IS NOT NULL
      WHERE vp.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY vp.paid_on DESC, vp.batch_id DESC NULLS LAST, vp.id DESC
    `,
  });
}

export default listVendorPayments;
