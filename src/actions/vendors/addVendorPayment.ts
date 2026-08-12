import { action } from '@uibakery/data';

function addVendorPayment() {
  return action('addVendorPayment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH lck AS (
        -- serialize payments per vendor+campaign: the remaining-demand caps
        -- below read v_vendor_balances and then insert — two concurrent
        -- submits (double-click, two operators) must not both pass the same
        -- remaining figure. hashtext collisions merely over-serialize.
        SELECT pg_advisory_xact_lock(42002, hashtext({{params.vendor_id}}::text || ':' || {{params.group_buy_id}}::text)) AS locked
      ), ins AS (
        INSERT INTO vendor_payments (vendor_id, group_buy_id, paid_on, amount_usd, wallet_id, method, receipt_ref, note, kits_qty, freight_usd)
        SELECT
          {{params.vendor_id}}::bigint,
          {{params.group_buy_id}}::bigint,
          {{params.paid_on}}::date,
          {{params.amount_usd}}::numeric,
          NULLIF({{params.wallet_id}}::text, '')::bigint,
          NULLIF({{params.method}}::text, ''),
          NULLIF({{params.receipt_ref}}::text, ''),
          NULLIF({{params.note}}::text, ''),
          NULLIF({{params.kits_qty}}::text, '')::numeric,
          NULLIF({{params.freight_usd}}::text, '')::numeric
        FROM lck
        -- optional breakdown fields: blank = not provided; when provided they
        -- must be clean 2-decimal values (same string-scale rule as every
        -- other quantity boundary)
        WHERE ({{params.kits_qty}}::text = '' OR ({{params.kits_qty}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
               -- can't record paying for more kits than this vendor is
               -- currently owed — a typo (1000 for 100) must refuse, not
               -- silently over-close the tracker
               AND ({{params.kits_qty}})::numeric <= (
                 SELECT vb.kits_demand - vb.kits_paid
                 FROM v_vendor_balances vb
                 WHERE vb.vendor_id = {{params.vendor_id}}::bigint
                   AND vb.group_buy_id = {{params.group_buy_id}}::bigint
               )))
          AND ({{params.freight_usd}}::text = '' OR ({{params.freight_usd}}::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
               -- freight is a portion of THIS payment — never more than it
               AND ({{params.freight_usd}})::numeric <= {{params.amount_usd}}::numeric
               -- and never more than the freight still owed to this vendor
               AND ({{params.freight_usd}})::numeric <= (
                 SELECT vb.freight_demand_usd - vb.freight_paid_usd
                 FROM v_vendor_balances vb
                 WHERE vb.vendor_id = {{params.vendor_id}}::bigint
                   AND vb.group_buy_id = {{params.group_buy_id}}::bigint
               )))
        RETURNING id, vendor_id, amount_usd, kits_qty, freight_usd
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'vendor_payments', ins.id::text, 'insert', {{params.actor}},
             jsonb_build_object('vendor_id', ins.vendor_id, 'amount_usd', ins.amount_usd, 'kits_qty', ins.kits_qty, 'freight_usd', ins.freight_usd)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addVendorPayment;
