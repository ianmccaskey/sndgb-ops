import { action } from '@uibakery/data';

function listVendorPayments() {
  return action('listVendorPayments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT vp.id, vp.paid_on, vp.amount_usd, vp.method, vp.receipt_ref, vp.note,
             v.code AS vendor_code, w.name AS wallet_name
      FROM vendor_payments vp
      JOIN vendors v ON v.id = vp.vendor_id
      LEFT JOIN wallets w ON w.id = vp.wallet_id
      WHERE vp.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY vp.paid_on DESC, vp.id DESC
    `,
  });
}

export default listVendorPayments;
