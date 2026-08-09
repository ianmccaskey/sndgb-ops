import { action } from '@uibakery/data';

function addVendorPayment() {
  return action('addVendorPayment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note)
        VALUES (
          {{params.vendor_id}}::bigint,
          {{params.group_buy_id}}::bigint,
          {{params.paid_on}}::date,
          {{params.amount_usd}}::numeric,
          NULLIF({{params.wallet_id}}::text, '')::bigint,
          NULLIF({{params.method}}::text, ''),
          NULLIF({{params.receipt_ref}}::text, ''),
          NULLIF({{params.note}}::text, '')
        )
        RETURNING id, vendor_id, amount_usd
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'vendor_payments', ins.id::text, 'insert', {{params.actor}},
             jsonb_build_object('vendor_id', ins.vendor_id, 'amount_usd', ins.amount_usd)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addVendorPayment;
