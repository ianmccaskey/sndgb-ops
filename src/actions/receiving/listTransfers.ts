import { action } from '@uibakery/data';

/**
 * Transfer log (drafts first, then newest finalized) with items jsonb.
 * CAMPAIGN-SCOPED: a transfer belongs to the selected campaign when its
 * source package is stamped with it, or (no source package) when any of
 * its items is a campaign product, or (direct-ship) when its linked order
 * is in the campaign. An item-less non-direct draft has no campaign
 * evidence — it shows everywhere rather than hiding from both admins.
 */
function listTransfers() {
  return action('listTransfers', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT t.id, t.from_address_id, t.source_package_id,
             -- the SNAPSHOT is the truth for history; the live label only
             -- covers pre-snapshot rows the backfill could not know better
             COALESCE(t.from_label, ra.label) AS from_label,
             t.from_address,
             t.destination_label, t.destination, t.parcel,
             t.carrier, t.servicelevel, t.rate_amount, t.rate_currency,
             -- '#' guard: 22-digit USPS numbers get rounded by the JS
             -- transport unless they travel with a non-digit char; NULLs
             -- stay NULL ('#'||NULL); stripped at the row boundary
             t.shippo_rate_id, t.shippo_transaction_id,
             '#' || t.tracking_number AS tracking_number, t.label_url,
             t.refund_status, t.note, t.finalized_at, t.created_by, t.created_at,
             -- exact-text token for the attempted-clear CAS (jsonb round
             -- trip preserves microseconds; driver Date coercion may not)
             (jsonb_build_object('a', t.purchase_attempted_at)->>'a') AS purchase_attempted_at,
             t.direct_order_item_id, t.direct_link_reclaimed_at,
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
      WHERE EXISTS (SELECT 1 FROM inbound_packages sp
                    WHERE sp.id = t.source_package_id
                      AND sp.group_buy_id = {{params.group_buy_id}}::bigint)
         OR (t.source_package_id IS NULL AND (
              EXISTS (SELECT 1 FROM transfer_items ti
                      JOIN group_buy_products g ON g.product_id = ti.product_id
                        AND g.group_buy_id = {{params.group_buy_id}}::bigint
                      WHERE ti.transfer_id = t.id)
              OR EXISTS (SELECT 1 FROM order_items oi
                         JOIN orders o ON o.id = oi.order_id
                         WHERE oi.id = t.direct_order_item_id
                           AND o.group_buy_id = {{params.group_buy_id}}::bigint)
              OR (t.direct_order_item_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM transfer_items ti2 WHERE ti2.transfer_id = t.id))))
      ORDER BY t.finalized_at NULLS FIRST, t.created_at DESC
    `,
  });
}

export default listTransfers;
