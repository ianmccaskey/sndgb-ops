import { action } from '@uibakery/data';

function listVendorBalances() {
  return action('listVendorBalances', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT vendor_id, vendor_code, group_buy_id, group_buy_name,
             owed_usd, product_owed_usd, freight_demand_usd, kits_demand,
             paid_usd, kits_paid, freight_paid_usd, balance_usd, pay_status
      FROM v_vendor_balances
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY vendor_code
    `,
  });
}

export default listVendorBalances;
