import { action } from '@uibakery/data';

/**
 * Writes the result of an on-chain lookup (Moralis/Helius) onto a payment:
 * the observed USD amount, any native-token details, and verified/mismatch.
 */
function recordChainVerification() {
  return action('recordChainVerification', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH upd AS (
        UPDATE payments SET
          amount_usd = {{params.amount_usd}}::numeric,
          native_amount = NULLIF({{params.native_amount}}::text, '')::numeric,
          native_symbol = NULLIF({{params.native_symbol}}::text, ''),
          value_at_pay_usd = NULLIF({{params.value_at_pay_usd}}::text, '')::numeric,
          status = {{params.status}}::payment_status,
          verify_source = 'auto',
          verified_at = now(),
          notes = NULLIF({{params.notes}}::text, '')
        WHERE id = {{params.payment_id}}::bigint
        RETURNING id, order_id, amount_usd, status
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'payments', upd.id::text, 'chain_verify', {{params.actor}},
             jsonb_build_object('order_id', upd.order_id, 'amount_usd', upd.amount_usd, 'status', upd.status)
      FROM upd
      RETURNING row_pk AS id
    `,
  });
}

export default recordChainVerification;
