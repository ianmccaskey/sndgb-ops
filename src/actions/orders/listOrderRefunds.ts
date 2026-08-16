import { action } from '@uibakery/data';

function listOrderRefunds() {
  return action('listOrderRefunds', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT orf.id, orf.amount_usd, orf.method, orf.wallet_id, w.name AS wallet_name,
             orf.tx_ref, orf.reason, orf.created_by, orf.created_at
      FROM order_refunds orf
      LEFT JOIN wallets w ON w.id = orf.wallet_id
      WHERE orf.order_id = {{params.order_id}}::bigint
      ORDER BY orf.created_at
    `,
  });
}

export default listOrderRefunds;
