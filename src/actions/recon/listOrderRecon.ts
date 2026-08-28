import { action } from '@uibakery/data';

function listOrderRecon() {
  return action('listOrderRecon', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT r.order_id, r.order_number, r.customer_name, r.payment_rail, r.order_status,
             r.billed_usd, r.comp_usd, r.writeoff_usd, r.due_usd, r.received_usd, r.override_usd, r.effective_received_usd,
             r.diff_usd, r.pending_payment_count, r.recon_status,
             -- flags the UNRESOLVED condition: any non-rejected payment
             -- carrying native value with no USD pricing (covers mixed
             -- stablecoin+native txs that verified on the stable leg); an
             -- order-level override resolves it and clears the flag
             CASE WHEN r.override_usd IS NULL THEN
               (SELECT string_agg(DISTINCT p.native_symbol, ' + ')
                FROM payments p
                WHERE p.order_id = r.order_id
                  AND p.native_symbol IS NOT NULL
                  AND p.value_at_pay_usd IS NULL
                  AND p.status <> 'rejected')
             END AS native_unpriced
      FROM v_order_reconciliation r
      WHERE group_buy_id = {{params.group_buy_id}}::bigint
        AND ({{params.recon}}::text = 'all' OR recon_status = {{params.recon}}::text)
        AND (COALESCE({{params.rail}}::text, 'all') = 'all'
             OR (COALESCE({{params.rail}}::text, 'all') = 'crypto' AND payment_rail IN ('eth','sol','base'))
             OR payment_rail::text = COALESCE({{params.rail}}::text, 'all'))
      ORDER BY
        CASE recon_status WHEN 'short' THEN 0 WHEN 'over' THEN 1 WHEN 'awaiting' THEN 2 ELSE 3 END,
        ABS(diff_usd) DESC
      LIMIT 1000
    `,
  });
}

export default listOrderRecon;
