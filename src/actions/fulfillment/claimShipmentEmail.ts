import { action } from '@uibakery/data';

/**
 * CAS claim for the customer "shipped" email on one order shipment: only
 * the session that flips tracking_email_sent_at from NULL gets a row
 * back, and only that session may send. Zero rows = nothing to send
 * (already sent/claimed, not finalized, no destination email, no
 * tracking, or refund activity on the label) — callers treat it as a
 * silent no-op, so recovery paths can call this unconditionally.
 * A send failure releases the claim via recordShipmentEmailError.
 */
function claimShipmentEmail() {
  return action('claimShipmentEmail', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH claimed AS (
        UPDATE shipments s
           SET tracking_email_sent_at = now(), tracking_email_error = NULL
         WHERE s.id = {{params.shipment_id}}::bigint
           AND s.finalized_at IS NOT NULL
           AND s.tracking_email_sent_at IS NULL
           AND COALESCE(btrim(s.destination->>'email'), '') <> ''
           AND COALESCE(btrim(s.tracking_number), '') <> ''
           -- any refund activity (even a failed request) means a human is
           -- unwinding this label — never auto-email "shipped" on it
           AND s.refund_status IS NULL
        RETURNING s.id, s.order_id, s.carrier, s.servicelevel, s.tracking_number, s.destination, s.tracking_email_sent_at
      )
      SELECT c.id, c.carrier, COALESCE(c.servicelevel, '') AS servicelevel,
             -- exact-text claim token for the release/unverified CAS
             -- (jsonb round trip preserves microseconds; driver Date
             -- coercion may not — purchase_attempted_at precedent)
             (jsonb_build_object('a', c.tracking_email_sent_at)->>'a') AS claimed_at,
             -- '#' guard: digit-only tracking survives the JS transport
             '#' || c.tracking_number AS tracking_number,
             btrim(c.destination->>'email') AS email,
             COALESCE(c.destination->>'name', '') AS dest_name,
             o.order_number,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('sku', p.sku_code, 'name', p.name, 'qty', si.qty) ORDER BY p.sku_code)
                         FROM shipment_items si
                         JOIN order_items oi ON oi.id = si.order_item_id
                         JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
                         JOIN products p ON p.id = gbp.product_id
                        WHERE si.shipment_id = c.id), '[]'::jsonb) AS items
      FROM claimed c
      JOIN orders o ON o.id = c.order_id
    `,
  });
}

export default claimShipmentEmail;
