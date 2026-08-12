import { action } from '@uibakery/data';

function getPnl() {
  return action('getPnl', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT pnl.*, splits.splits, adj.adjustments
      FROM v_group_buy_pnl pnl
      LEFT JOIN (
        SELECT group_buy_id,
               jsonb_agg(jsonb_build_object('party', party, 'pct', pct) ORDER BY pct DESC) AS splits
        FROM profit_splits
        GROUP BY group_buy_id
      ) splits ON splits.group_buy_id = pnl.group_buy_id
      LEFT JOIN (
        -- adjustment value per beneficiary: 'both' is already deducted in the
        -- view; party rows come out of that party's split payout in the UI
        SELECT t.group_buy_id,
               jsonb_agg(jsonb_build_object('beneficiary', t.beneficiary, 'value_usd', t.value_usd, 'count', t.cnt) ORDER BY t.beneficiary) AS adjustments
        FROM (
          SELECT gbp.group_buy_id, a.beneficiary, SUM(a.qty * gbp.gb_price_usd) AS value_usd, COUNT(*) AS cnt
          FROM admin_adjustments a
          JOIN group_buy_products gbp ON gbp.id = a.group_buy_product_id
          GROUP BY gbp.group_buy_id, a.beneficiary
        ) t
        GROUP BY t.group_buy_id
      ) adj ON adj.group_buy_id = pnl.group_buy_id
      WHERE pnl.group_buy_id = {{params.group_buy_id}}::bigint
    `,
  });
}

export default getPnl;
