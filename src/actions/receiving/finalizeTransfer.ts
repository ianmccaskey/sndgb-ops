import { action } from '@uibakery/data';

/**
 * Record the purchased label onto its draft — the transfer becomes real
 * (inventory decrements from here). OWNERSHIP CHECK: params.rate_id is
 * the rate the Shippo transaction was actually purchased against (as
 * reported by Shippo), and the update refuses unless it equals the
 * draft's stored shippo_rate_id — a mismatched transaction from a stale
 * client or bad retry can never finalize the wrong draft. Retryable: a
 * purchase-succeeded-but-finalize-failed draft can call this again with
 * the same transaction data; the finalized guard makes a double-fire
 * refuse harmlessly. If the draft carries direct_order_item_id, the
 * SAME statement stamps that order line direct_fulfilled_at — every
 * finalize path (primary, retry, recover-by-transaction) marks the
 * customer's order; the returned direct_stamped tells the client
 * whether it landed (0 = line was already fulfilled/removed meanwhile
 * — surface, don't retry). Tracking is surfaced on the line by joining
 * transfers through the link, so nothing is copied to drift. Audited.
 */
function finalizeTransfer() {
  return action('finalizeTransfer', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        UPDATE transfers t
        SET shippo_transaction_id = {{params.transaction_id}},
            tracking_number = NULLIF({{params.tracking_number}}::text, ''),
            label_url = {{params.label_url}},
            finalized_at = now()
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
          AND TRIM({{params.transaction_id}}) <> ''
          AND TRIM({{params.label_url}}) <> ''
          AND t.shippo_rate_id = TRIM({{params.rate_id}})
        RETURNING t.id, t.shippo_transaction_id, t.tracking_number, t.label_url, t.rate_amount,
                  t.carrier, t.direct_order_item_id, t.destination
      ),
      -- the linked direct-ship line completes WITH the label, in the same
      -- statement: only if it is still outstanding AND still passes the
      -- SAME money gates enforced at draft time — a draft finalized long
      -- after creation (retry/recovery paths) must not mark a line
      -- fulfilled on an order that went on hold or unpaid meanwhile —
      -- AND the transfer's item line still covers the line's CURRENT
      -- effective quantity (qty edits between draft and finalize must
      -- not let an under-shipment read as complete). Any refusal shows
      -- up as direct_stamped = 0 (the label itself is still recorded);
      -- the operator resolves in the order sheet.
      stamp AS (
        UPDATE order_items oi
        SET direct_fulfilled_at = now()
        FROM up, orders o
        LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
        WHERE up.direct_order_item_id IS NOT NULL
          AND oi.id = up.direct_order_item_id
          AND o.id = oi.order_id
          AND o.status NOT IN ('cancelled', 'refunded')
          AND NOT o.hold_shipping
          AND r.recon_status IN ('matched', 'over')
          AND r.pending_payment_count = 0
          AND oi.direct_ship AND oi.removed_at IS NULL
          AND oi.direct_fulfilled_at IS NULL
          AND EXISTS (
            SELECT 1 FROM transfer_items ti
            JOIN group_buy_products gbp ON gbp.id = oi.group_buy_product_id
            WHERE ti.transfer_id = up.id AND ti.product_id = gbp.product_id
              AND ti.qty >= COALESCE(oi.qty_override, oi.qty)
          )
          -- ship-to CAS at stamp time too: recovery paths finalize
          -- WITHOUT the pre-POST claim (the label already exists), so a
          -- label bought before an address correction must not complete
          -- the line — it records on the transfer, direct_stamped = 0,
          -- and the operator remediates (refund/reship) manually
          AND COALESCE(up.destination->>'street1', '') = COALESCE(o.address_line1, '')
          AND COALESCE(up.destination->>'street2', '') = COALESCE(o.address_line2, '')
          AND COALESCE(up.destination->>'city', '')    = COALESCE(o.city, '')
          AND COALESCE(up.destination->>'state', '')   = COALESCE(o.state_code, '')
          AND COALESCE(up.destination->>'zip', '')     = COALESCE(o.postal_code, '')
        RETURNING oi.id, oi.order_id
      ),
      stamp_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', s.id::text, 'direct_ship_label_attached', {{params.actor}},
               jsonb_build_object('order_id', s.order_id, 'transfer_id', up.id,
                                  'carrier', up.carrier, 'tracking_number', up.tracking_number)
        FROM stamp s, up
        RETURNING 1
      ),
      fin_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'transfers', up.id::text, 'transfer_finalized', {{params.actor}},
               jsonb_build_object('shippo_transaction_id', up.shippo_transaction_id,
                                  'tracking_number', up.tracking_number, 'label_url', up.label_url,
                                  'rate_amount', up.rate_amount,
                                  'direct_order_item_id', up.direct_order_item_id)
        FROM up
        RETURNING row_pk
      )
      SELECT fin_audit.row_pk AS id,
             up.direct_order_item_id,
             (SELECT count(*) FROM stamp) AS direct_stamped
      FROM fin_audit, up
    `,
  });
}

export default finalizeTransfer;
