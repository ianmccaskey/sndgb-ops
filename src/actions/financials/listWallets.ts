import { action } from '@uibakery/data';

function listWallets() {
  return action('listWallets', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT w.id, w.name, w.chain, w.address, w.active,
             s.balance_usd AS latest_balance_usd, s.native_balance AS latest_native_balance,
             s.taken_at AS latest_snapshot_at, s.source AS latest_source
      FROM wallets w
      LEFT JOIN LATERAL (
        SELECT balance_usd, native_balance, taken_at, source
        FROM wallet_snapshots ws WHERE ws.wallet_id = w.id
        ORDER BY taken_at DESC LIMIT 1
      ) s ON true
      ORDER BY w.id
    `,
  });
}

export default listWallets;
