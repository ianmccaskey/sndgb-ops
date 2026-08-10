import { action } from '@uibakery/data';

function listOrderRecon() {
  return action('listOrderRecon', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT order_id, order_number, customer_name, payment_rail, order_status,
             billed_usd, received_usd, override_usd, effective_received_usd,
             diff_usd, pending_payment_count, recon_status
      FROM v_order_reconciliation
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
        AND ({{params.recon}} = 'all' OR recon_status = {{params.recon}})
        AND ({{params.rail}} = 'all'
             OR ({{params.rail}} = 'crypto' AND payment_rail IN ('eth','sol','base'))
             OR payment_rail::text = {{params.rail}})
      ORDER BY
        CASE recon_status WHEN 'short' THEN 0 WHEN 'over' THEN 1 WHEN 'awaiting' THEN 2 ELSE 3 END,
        ABS(diff_usd) DESC
      LIMIT 1000
    `,
  });
}

export default listOrderRecon;
