import { action } from '@uibakery/data';

/** Transfer log (drafts first, then newest finalized) with items jsonb. */
function listTransfers() {
  return action('listTransfers', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT t.id, t.from_address_id,
             -- the SNAPSHOT is the truth for history; the live label only
             -- covers pre-snapshot rows the backfill could not know better
             COALESCE(t.from_label, ra.label) AS from_label,
             t.from_address,
             t.destination_label, t.destination, t.parcel,
             t.carrier, t.servicelevel, t.rate_amount, t.rate_currency,
             t.shippo_rate_id, t.shippo_transaction_id, t.tracking_number, t.label_url,
             t.refund_status, t.note, t.finalized_at, t.created_by, t.created_at,
             -- exact-text token for the attempted-clear CAS (jsonb round
             -- trip preserves microseconds; driver Date coercion may not)
             (jsonb_build_object('a', t.purchase_attempted_at)->>'a') AS purchase_attempted_at,
             COALESCE(items.items, '[]'::jsonb) AS items
      FROM transfers t
      JOIN receive_addresses ra ON ra.id = t.from_address_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object(
                 'product_id', i.product_id, 'sku_code', pr.sku_code, 'qty', i.qty
               ) ORDER BY pr.sku_code) AS items
        FROM transfer_items i
        JOIN products pr ON pr.id = i.product_id
        WHERE i.transfer_id = t.id
      ) items ON true
      ORDER BY t.finalized_at NULLS FIRST, t.created_at DESC
    `,
  });
}

export default listTransfers;
