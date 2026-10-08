import { action } from '@uibakery/data';

function listGroupBuys() {
  return action('listGroupBuys', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT gb.id, gb.external_id, gb.name, gb.status, gb.starts_on, gb.ends_on,
             gb.admin_fee_usd, gb.shipping_fee_usd, gb.cash_processor_fee_pct,
             gb.reconcile_tolerance_usd, gb.notes, gb.created_at,
             -- storefront (p2collective.app) publishing state; NULL = never set up
             cs.code AS storefront_code, cs.published AS storefront_published
      FROM group_buys gb
      LEFT JOIN storefront.campaign_settings cs ON cs.group_buy_id = gb.id
      ORDER BY gb.created_at DESC
    `,
  });
}

export default listGroupBuys;
