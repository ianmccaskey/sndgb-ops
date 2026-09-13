import { action } from '@uibakery/data';

function addWalletSnapshot() {
  return action('addWalletSnapshot', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO wallet_snapshots (wallet_id, balance_usd, native_balance, source, breakdown)
      VALUES (
        {{params.wallet_id}}::bigint,
        {{params.balance_usd}}::numeric,
        NULLIF({{params.native_balance}}::text, '')::numeric,
        {{params.source}}::verify_source,
        NULLIF({{params.breakdown}}::text, '')::jsonb
      )
      RETURNING id
    `,
  });
}

export default addWalletSnapshot;
