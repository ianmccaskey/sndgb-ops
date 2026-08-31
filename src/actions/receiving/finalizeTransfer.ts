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
      -- SELECT-lock first, stamp second, update transfers ONCE at the
      -- end: the transfers row must be written by exactly one CTE (a
      -- second same-statement update of the same row is silently
      -- skipped by Postgres), and whether direct_stamped_at is set
      -- depends on the stamp's outcome. FOR UPDATE preserves the
      -- double-finalize refusal: a concurrent finalize blocks on the
      -- lock, re-evaluates the WHERE, sees finalized_at set, and gets
      -- zero rows.
      -- LOCK ORDER matches claim and reclaim exactly: direct-line
      -- advisory lock FIRST, rows after — an inverted order here would
      -- deadlock a finalize against a concurrent claim/reclaim holding
      -- the advisory lock while waiting on this transfers row. The lock
      -- key comes from an UNLOCKED pre-read: a link can only go
      -- non-null->null (reclaim), so the worst staleness is taking a
      -- lock nobody else wants — harmless.
      WITH pre AS (
        SELECT t.direct_order_item_id AS pre_item
        FROM transfers t
        WHERE t.id = {{params.transfer_id}}::bigint
      ),
      lck AS (
        SELECT CASE WHEN pre.pre_item IS NOT NULL
                    THEN pg_advisory_xact_lock(hashtextextended('direct_line_' || pre.pre_item::text, 42005))
               END AS locked
        FROM pre
      ),
      -- shared cross-path tracking lock (42006 'track_'), held to commit:
      -- serializes this finalize against any concurrent MANUAL record of
      -- the same number (shipment or transfer), whose 120-day window check
      -- then sees this row committed instead of racing past it
      tlck AS (
        SELECT pg_advisory_xact_lock(hashtextextended(
                 'track_' || regexp_replace(UPPER(COALESCE({{params.tracking_number}}::text, '')), '[^A-Z0-9]', '', 'g'),
                 42006)) AS locked
        FROM lck
      ),
      sel AS (
        SELECT t.id, t.rate_amount, t.carrier, t.direct_order_item_id, t.destination, t.direct_link_reclaimed_at
        FROM transfers t, lck, tlck
        WHERE t.id = {{params.transfer_id}}::bigint
          AND t.finalized_at IS NULL
          AND TRIM({{params.transaction_id}}::text) <> ''
          AND TRIM({{params.label_url}}::text) <> ''
          AND t.shippo_rate_id = TRIM({{params.rate_id}}::text)
        FOR UPDATE OF t
      ),
      -- ROW-LOCK the order (FOR UPDATE) so the stamp's gates are
      -- evaluated on the LATEST committed order state — a hold or
      -- address correction committing mid-statement is seen, not missed
      -- on the statement's opening snapshot
      olock AS (
        SELECT o.id, o.status, o.hold_shipping, o.group_buy_id,
               o.address_line1, o.address_line2, o.city, o.state_code, o.postal_code
        FROM sel
        JOIN order_items oi0 ON oi0.id = sel.direct_order_item_id
        JOIN orders o ON o.id = oi0.order_id
        FOR UPDATE OF o
      ),
      -- the linked direct-ship line completes WITH the label, in the same
      -- statement: only if it is still outstanding AND still passes the
      -- SAME money gates enforced at draft time — a draft finalized long
      -- after creation (retry/recovery paths) must not mark a line
      -- fulfilled on an order that went on hold or unpaid meanwhile —
      -- AND the CUMULATIVE finalized non-voided fills for the line (this
      -- transfer included) cover its CURRENT effective quantity: partial
      -- fills record without stamping and the line completes when the
      -- running total reaches the ordered qty (vendor sent everything to
      -- us; direct ships are filled from received stock in pieces). Any
      -- refusal shows up as direct_stamped = 0 (the label itself is
      -- still recorded); direct_filled/direct_ordered tell the client
      -- whether that is an expected partial or a gate refusal to surface.
      stamp AS (
        UPDATE order_items oi
        -- direct_fulfilled_transfer_id records WHICH transfer owns this
        -- fulfillment — the order sheet's tracking joins through it, and
        -- the manual undo clears it, so a stamped-then-undone transfer
        -- can never resurface as the line's shipment later
        SET direct_fulfilled_at = now(), direct_fulfilled_transfer_id = sel.id
        FROM sel, olock o
        LEFT JOIN v_order_reconciliation r ON r.order_id = o.id
        WHERE sel.direct_order_item_id IS NOT NULL
          AND oi.id = sel.direct_order_item_id
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
            WHERE ti.transfer_id = sel.id AND ti.product_id = gbp.product_id
              AND ti.qty > 0
          )
          -- cumulative coverage: THIS transfer is not finalized in the
          -- statement snapshot, so it is included by id
          AND (
            SELECT COALESCE(sum(ti2.qty), 0)
            FROM transfers t3
            JOIN transfer_items ti2 ON ti2.transfer_id = t3.id
            JOIN group_buy_products gbp3 ON gbp3.id = oi.group_buy_product_id
              AND ti2.product_id = gbp3.product_id
            WHERE t3.direct_order_item_id = oi.id
              AND (t3.finalized_at IS NOT NULL OR t3.id = sel.id)
              AND COALESCE(t3.refund_status, '') <> 'SUCCESS'
          ) >= COALESCE(oi.qty_override, oi.qty)
          -- campaign consistency at stamp time: the line's own gbp fixes
          -- its campaign — an order REASSIGNED to another buy after the
          -- draft was validated mismatches and refuses
          AND EXISTS (
            SELECT 1 FROM group_buy_products gbp2
            WHERE gbp2.id = oi.group_buy_product_id AND gbp2.group_buy_id = o.group_buy_id
          )
          -- ship-to CAS at stamp time too: recovery paths finalize
          -- WITHOUT the pre-POST claim (the label already exists), so a
          -- label bought before an address correction must not complete
          -- the line — it records on the transfer, direct_stamped = 0,
          -- and the operator remediates (refund/reship) manually
          AND COALESCE(sel.destination->>'street1', '') = COALESCE(o.address_line1, '')
          AND COALESCE(sel.destination->>'street2', '') = COALESCE(o.address_line2, '')
          AND COALESCE(sel.destination->>'city', '')    = COALESCE(o.city, '')
          AND COALESCE(sel.destination->>'state', '')   = COALESCE(o.state_code, '')
          AND COALESCE(sel.destination->>'zip', '')     = COALESCE(o.postal_code, '')
        RETURNING oi.id, oi.order_id
      ),
      -- the ONE write to the transfers row: label fields + finalized_at,
      -- and direct_stamped_at ONLY when the stamp actually landed — the
      -- durable "THIS transfer fulfilled the line" record the order
      -- sheet's tracking join requires
      up AS (
        UPDATE transfers t
        SET shippo_transaction_id = {{params.transaction_id}}::text,
            tracking_number = NULLIF({{params.tracking_number}}::text, ''),
            label_url = {{params.label_url}}::text,
            finalized_at = now(),
            direct_stamped_at = CASE WHEN EXISTS (SELECT 1 FROM stamp) THEN now() ELSE t.direct_stamped_at END
        FROM sel
        WHERE t.id = sel.id
        RETURNING t.id, t.shippo_transaction_id, t.tracking_number, t.label_url, t.rate_amount,
                  t.carrier, t.direct_order_item_id, t.direct_link_reclaimed_at
      ),
      -- destination is one of OUR receive addresses: materialize the box
      -- as an INCOMING inbound package there (committed — trackable —
      -- and physically receivable on arrival). Guarded against an
      -- existing ACTIVE package on the same (carrier, tracking).
      incoming AS (
        INSERT INTO inbound_packages (receive_address_id, carrier, tracking_number, note, created_by, committed_at)
        SELECT t2.dest_receive_address_id, LOWER(up.carrier),
               regexp_replace(UPPER(TRIM(up.tracking_number)), '\\s', '', 'g'),
               'Incoming transfer from ' || COALESCE(t2.from_label, ''), {{params.actor}}::text, now()
        FROM up
        JOIN transfers t2 ON t2.id = up.id
        WHERE t2.dest_receive_address_id IS NOT NULL
          AND COALESCE(up.tracking_number, '') <> ''
          AND EXISTS (SELECT 1 FROM receive_addresses ra WHERE ra.id = t2.dest_receive_address_id AND ra.active)
          AND NOT EXISTS (
            SELECT 1 FROM inbound_packages x
            WHERE x.received_at IS NULL AND x.carrier = LOWER(up.carrier)
              AND UPPER(x.tracking_number) = regexp_replace(UPPER(TRIM(up.tracking_number)), '\\s', '', 'g'))
        RETURNING id
      ),
      incoming_items AS (
        INSERT INTO inbound_package_items (package_id, product_id, qty)
        SELECT incoming.id, ti.product_id, ti.qty
        FROM incoming, up
        JOIN transfer_items ti ON ti.transfer_id = up.id
        RETURNING 1
      ),
      incoming_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'inbound_packages', incoming.id::text, 'package_created', {{params.actor}}::text,
               jsonb_build_object('from_transfer_id', up.id, 'carrier', LOWER(up.carrier),
                                  'tracking_number', up.tracking_number)
        FROM incoming, up
        RETURNING 1
      ),
      stamp_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'order_items', s.id::text, 'direct_ship_label_attached', {{params.actor}}::text,
               jsonb_build_object('order_id', s.order_id, 'transfer_id', up.id,
                                  'carrier', up.carrier, 'tracking_number', up.tracking_number)
        FROM stamp s, up
        RETURNING 1
      ),
      fin_audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'transfers', up.id::text, 'transfer_finalized', {{params.actor}}::text,
               jsonb_build_object('shippo_transaction_id', up.shippo_transaction_id,
                                  'tracking_number', up.tracking_number, 'label_url', up.label_url,
                                  'rate_amount', up.rate_amount,
                                  'direct_order_item_id', up.direct_order_item_id)
        FROM up
        RETURNING row_pk
      )
      SELECT fin_audit.row_pk AS id,
             up.direct_order_item_id,
             -- non-null = this draft LOST its direct-ship reservation to a
             -- newer draft before this label was recovered: the label is
             -- real and recorded, but it is ORPHANED from any order line —
             -- the caller must warn about a possible duplicate
             (jsonb_build_object('r', up.direct_link_reclaimed_at)->>'r') AS direct_link_reclaimed_at,
             (SELECT count(*) FROM stamp) AS direct_stamped,
             -- fill progress for the linked line (this transfer included):
             -- lets the client tell an expected partial from a gate refusal
             (SELECT COALESCE(oi4.qty_override, oi4.qty)::text
              FROM order_items oi4 WHERE oi4.id = up.direct_order_item_id) AS direct_ordered,
             (SELECT COALESCE(sum(ti4.qty), 0)::text
              FROM transfers t4
              JOIN transfer_items ti4 ON ti4.transfer_id = t4.id
              JOIN order_items oi5 ON oi5.id = up.direct_order_item_id
              JOIN group_buy_products g4 ON g4.id = oi5.group_buy_product_id
                AND ti4.product_id = g4.product_id
              WHERE t4.direct_order_item_id = up.direct_order_item_id
                AND (t4.finalized_at IS NOT NULL OR t4.id = up.id)
                AND COALESCE(t4.refund_status, '') <> 'SUCCESS') AS direct_filled
      FROM fin_audit, up
    `,
  });
}

export default finalizeTransfer;
