import { action } from '@uibakery/data';

function listGroupBuys() {
  return action('listGroupBuys', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, external_id, name, status, starts_on, ends_on,
             admin_fee_usd, shipping_fee_usd, cash_processor_fee_pct,
             reconcile_tolerance_usd, notes, created_at
      FROM group_buys
      ORDER BY created_at DESC
    `,
  });
}

export default listGroupBuys;
