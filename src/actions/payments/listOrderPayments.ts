import { action } from '@uibakery/data';

function listOrderPayments() {
  return action('listOrderPayments', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, method, tx_hash, receipt_ref, amount_usd, native_amount, native_symbol,
             value_at_pay_usd, status, verify_source, verified_at, notes, created_at
      FROM payments
      WHERE order_id = {{params.order_id}}::bigint
      ORDER BY created_at
    `,
  });
}

export default listOrderPayments;
