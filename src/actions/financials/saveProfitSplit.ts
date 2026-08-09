import { action } from '@uibakery/data';

function saveProfitSplit() {
  return action('saveProfitSplit', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO profit_splits (group_buy_id, party, pct)
      VALUES ({{params.group_buy_id}}::bigint, {{params.party}}, {{params.pct}}::numeric)
      ON CONFLICT (group_buy_id, party) DO UPDATE SET pct = EXCLUDED.pct
      RETURNING id
    `,
  });
}

export default saveProfitSplit;
