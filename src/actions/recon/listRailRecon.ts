import { action } from '@uibakery/data';

function listRailRecon() {
  return action('listRailRecon', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT rr.payment_rail, rr.order_count, rr.billed_usd, rr.received_usd, rr.gap_usd,
             ws.wallet_name, ws.wallet_balance_usd, ws.taken_at AS snapshot_at
      FROM v_rail_reconciliation rr
      LEFT JOIN LATERAL (
        SELECT w.name AS wallet_name, s.balance_usd AS wallet_balance_usd, s.taken_at
        FROM wallets w
        JOIN wallet_snapshots s ON s.wallet_id = w.id
        WHERE w.chain::text = rr.payment_rail::text
           OR (rr.payment_rail = 'cash' AND w.chain = 'fiat')
        ORDER BY s.taken_at DESC
        LIMIT 1
      ) ws ON true
      WHERE rr.group_buy_id = {{params.group_buy_id}}::bigint
      ORDER BY rr.payment_rail
    `,
  });
}

export default listRailRecon;
