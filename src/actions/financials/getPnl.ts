import { action } from '@uibakery/data';

function getPnl() {
  return action('getPnl', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT pnl.*, splits.splits
      FROM v_group_buy_pnl pnl
      LEFT JOIN (
        SELECT group_buy_id,
               jsonb_agg(jsonb_build_object('party', party, 'pct', pct) ORDER BY pct DESC) AS splits
        FROM profit_splits
        GROUP BY group_buy_id
      ) splits ON splits.group_buy_id = pnl.group_buy_id
      WHERE pnl.group_buy_id = {{params.group_buy_id}}::bigint
    `,
  });
}

export default getPnl;
