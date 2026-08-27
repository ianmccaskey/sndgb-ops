import { action } from '@uibakery/data';

function updateGroupBuy() {
  return action('updateGroupBuy', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE group_buys SET
        name = {{params.name}}::text,
        status = {{params.status}}::group_buy_status,
        starts_on = NULLIF({{params.starts_on}}::text, '')::date,
        ends_on = NULLIF({{params.ends_on}}::text, '')::date,
        admin_fee_usd = {{params.admin_fee_usd}}::numeric,
        shipping_fee_usd = {{params.shipping_fee_usd}}::numeric,
        cash_processor_fee_pct = {{params.cash_processor_fee_pct}}::numeric,
        reconcile_tolerance_usd = {{params.reconcile_tolerance_usd}}::numeric,
        notes = NULLIF({{params.notes}}::text, '')
      WHERE id = {{params.id}}::bigint
      RETURNING id
    `,
  });
}

export default updateGroupBuy;
