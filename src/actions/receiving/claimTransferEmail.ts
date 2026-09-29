import { action } from '@uibakery/data';

/**
 * CAS claim for the customer "shipped" email on a DIRECT-SHIP transfer —
 * the only transfer kind with a customer on the other end; internal
 * admin-to-admin transfers never match (direct_order_item_id IS NULL).
 * A draft whose direct-ship reservation was RECLAIMED by a newer draft
 * is excluded too: its recovered label is orphaned from the order line
 * and possibly a duplicate — a human decides, not an auto-email.
 * Zero rows = silent no-op for the caller; a send failure releases the
 * claim via recordTransferEmailError.
 */
function claimTransferEmail() {
  return action('claimTransferEmail', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH claimed AS (
        UPDATE transfers t
           SET tracking_email_sent_at = now(), tracking_email_error = NULL
         WHERE t.id = {{params.transfer_id}}::bigint
           AND t.finalized_at IS NOT NULL
           AND t.tracking_email_sent_at IS NULL
           AND t.direct_order_item_id IS NOT NULL
           AND t.direct_link_reclaimed_at IS NULL
           AND COALESCE(btrim(t.destination->>'email'), '') <> ''
           AND COALESCE(btrim(t.tracking_number), '') <> ''
           AND t.refund_status IS NULL
        RETURNING t.id, t.carrier, t.servicelevel, t.tracking_number, t.destination, t.direct_order_item_id, t.tracking_email_sent_at
      )
      SELECT c.id, c.carrier, COALESCE(c.servicelevel, '') AS servicelevel,
             -- exact-text claim token for the release/unverified CAS
             (jsonb_build_object('a', c.tracking_email_sent_at)->>'a') AS claimed_at,
             -- '#' guard: digit-only tracking survives the JS transport
             '#' || c.tracking_number AS tracking_number,
             btrim(c.destination->>'email') AS email,
             COALESCE(c.destination->>'name', '') AS dest_name,
             o.order_number,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('sku', pr.sku_code, 'name', pr.name, 'qty', ti.qty) ORDER BY pr.sku_code)
                         FROM transfer_items ti
                         JOIN products pr ON pr.id = ti.product_id
                        WHERE ti.transfer_id = c.id), '[]'::jsonb) AS items
      FROM claimed c
      JOIN order_items oi ON oi.id = c.direct_order_item_id
      JOIN orders o ON o.id = oi.order_id
    `,
  });
}

export default claimTransferEmail;
