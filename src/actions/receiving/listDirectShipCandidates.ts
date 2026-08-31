import { action } from '@uibakery/data';

/**
 * Outstanding vendor-direct order lines eligible to be shipped from a
 * receive address straight to the customer — one row per order line,
 * with the order's ship-to snapshot. Money-gated EXACTLY like the
 * Fulfillment direct queue (matched/over recon, no pending payments,
 * not held) and address-gated (no ship-to = not shippable). The same
 * gates are re-enforced inside create_transfer_draft() at write time —
 * this list is UX, not the trust boundary.
 */
function listDirectShipCandidates() {
  return action('listDirectShipCandidates', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT oi.id AS item_id, o.id AS order_id, o.order_number,
             c.display_name AS customer_name,
             o.contact_name, o.contact_phone, o.contact_email,
             o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code,
             gbp.product_id, p.sku_code,
             COALESCE(oi.qty_override, oi.qty) AS qty,
             -- partial fills already sent against this line (finalized,
             -- non-voided transfers carrying the line's product)
             COALESCE(f.filled, 0) AS filled_qty
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN customers c ON c.id = o.customer_id
      JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
      JOIN products p ON p.id = gbp.product_id
      LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
      LEFT JOIN LATERAL (
        -- only transfers sent to the order's CURRENT ship-to count —
        -- an address correction resets visible progress (those units
        -- went to the old address; the operator remediates)
        SELECT sum(ti.qty) AS filled
        FROM transfers t
        JOIN transfer_items ti ON ti.transfer_id = t.id AND ti.product_id = gbp.product_id
        WHERE t.direct_order_item_id = oi.id
          AND t.finalized_at IS NOT NULL
          AND COALESCE(t.refund_status, '') <> 'SUCCESS'
          AND COALESCE(t.destination->>'street1', '') = COALESCE(o.address_line1, '')
          AND COALESCE(t.destination->>'street2', '') = COALESCE(o.address_line2, '')
          AND COALESCE(t.destination->>'city', '')    = COALESCE(o.city, '')
          AND COALESCE(t.destination->>'state', '')   = COALESCE(o.state_code, '')
          AND COALESCE(t.destination->>'zip', '')     = COALESCE(o.postal_code, '')
      ) f ON true
      WHERE o.group_buy_id = {{params.group_buy_id}}::bigint
        AND o.status NOT IN ('cancelled', 'refunded')
        AND NOT o.hold_shipping
        AND r.recon_status IN ('matched', 'over')
        AND r.pending_payment_count = 0
        AND oi.direct_ship AND oi.direct_fulfilled_at IS NULL AND oi.removed_at IS NULL
        AND COALESCE(o.address_line1, '') <> ''
      ORDER BY o.order_number, p.sku_code
      -- 1001 = 1000 shown + 1 overflow sentinel: the client warns when a
      -- campaign exceeds the window instead of silently hiding lines
      LIMIT 1001
    `,
  });
}

export default listDirectShipCandidates;
