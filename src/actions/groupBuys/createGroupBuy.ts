import { action } from '@uibakery/data';

function createGroupBuy() {
  return action('createGroupBuy', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO group_buys (name, status, starts_on, ends_on, admin_fee_usd, shipping_fee_usd, cash_processor_fee_pct)
      VALUES (
        {{params.name}}::text,
        'draft',
        NULLIF({{params.starts_on}}::text, '')::date,
        NULLIF({{params.ends_on}}::text, '')::date,
        {{params.admin_fee_usd}}::numeric,
        {{params.shipping_fee_usd}}::numeric,
        {{params.cash_processor_fee_pct}}::numeric
      )
      RETURNING id
    `,
  });
}

export default createGroupBuy;
