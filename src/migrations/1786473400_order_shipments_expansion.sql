-- Order shipments grow the full Shippo draft-first lifecycle (parity with
-- transfers, 1786471100/1786471400/1786471600/1786471800) plus per-item
-- attribution, so an order can ship in MULTIPLE boxes (partial shipments,
-- one tracking number each) and every packed quantity is accounted:
--   * draft-first: finalized_at NULL until the label purchase lands, so a
--     failed purchase never leaves a phantom "shipped" row; fulfilled math
--     counts only non-voided rows (refund_status <> 'SUCCESS')
--   * shippo_rate_id UNIQUE = double-purchase backstop; transaction id
--     partial unique = double-attach backstop (same rationale as transfers)
--   * purchase_started_at (short exclusivity lease, birth-stamped) vs
--     purchase_attempted_at (durable "a Shippo POST was dispatched") vs
--     attempt_verified_no_label_at (proof-of-absence walk passed, draft
--     may be deleted) — the transfers three-state lease model
--   * b44_pushed_at: the upstream (ordering app) push landed AND verified;
--     NULL keeps the retry surface visible, so a failed push is never
--     silently dropped
-- Deliberately NO global unique on tracking_number: USPS recycles numbers
-- after ~120 days, so an unconditional cross-era constraint could wrongly
-- block a legitimate reuse with no override (same reasoning as transfers,
-- 1786473200). Manual entry gets a manual-only race-backstop index here
-- plus a fn-level 120-day cross-path window check in
-- create_manual_shipment; Shippo-purchased tracking is recorded verbatim
-- at finalize (money moved — refusing would orphan a paid label).
ALTER TABLE shipments
  ADD COLUMN ship_from_address_id bigint REFERENCES receive_addresses(id),
  ADD COLUMN from_label TEXT,
  ADD COLUMN from_address jsonb,
  ADD COLUMN destination jsonb,
  ADD COLUMN parcel jsonb,
  ADD COLUMN servicelevel TEXT,
  ADD COLUMN rate_amount NUMERIC(12,2),
  ADD COLUMN rate_currency TEXT,
  ADD COLUMN shippo_rate_id TEXT CONSTRAINT shipments_rate_unique UNIQUE,
  ADD COLUMN shippo_transaction_id TEXT,
  ADD COLUMN label_url TEXT,
  ADD COLUMN refund_status TEXT,
  ADD COLUMN refund_requested_at timestamptz,
  ADD COLUMN purchase_started_at timestamptz,
  ADD COLUMN purchase_attempted_at timestamptz,
  ADD COLUMN attempt_verified_no_label_at timestamptz,
  ADD COLUMN finalized_at timestamptz,
  ADD COLUMN b44_pushed_at timestamptz,
  ADD COLUMN created_by TEXT;

CREATE UNIQUE INDEX shipments_transaction_uniq ON shipments (shippo_transaction_id)
  WHERE shippo_transaction_id IS NOT NULL;

-- manual-vs-manual race backstop (the fn-level 120-day window check is the
-- exact rule; this catches two concurrent manual records of one label)
CREATE UNIQUE INDEX shipments_manual_tracking_uniq
  ON shipments (regexp_replace(upper(tracking_number), '[^A-Z0-9]', '', 'g'))
  WHERE shippo_rate_id IS NULL AND tracking_number IS NOT NULL;

-- Attribution: WHICH lines (and how much of each) went in THIS box.
-- order_items has UNIQUE(order_id, group_buy_product_id), so attribution is
-- quantity-based on the one line, never duplicate rows. A draft's rows
-- RESERVE their quantities (remaining = effective - attributed over
-- non-voided shipments, drafts included); deleting the draft frees them.
CREATE TABLE shipment_items (
  id bigserial PRIMARY KEY,
  shipment_id bigint NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  order_item_id bigint NOT NULL REFERENCES order_items(id),
  qty NUMERIC(10,2) NOT NULL CONSTRAINT shipment_items_qty_positive CHECK (qty > 0),
  UNIQUE (shipment_id, order_item_id)
);
CREATE INDEX shipment_items_order_item_idx ON shipment_items (order_item_id);

-- ===== Legacy reconciliation (shipments verified EMPTY at migration time —
-- both statements are provable no-ops kept as guards for replay safety) =====
-- (1) any pre-expansion SHIPPED row gets whole-order attribution so
--     historical fulfilled math is consistent, and is marked born-finalized
INSERT INTO shipment_items (shipment_id, order_item_id, qty)
SELECT s.id, oi.id, COALESCE(oi.qty_override, oi.qty)
FROM shipments s
JOIN order_items oi ON oi.order_id = s.order_id
  AND NOT oi.direct_ship AND oi.removed_at IS NULL
WHERE s.status IN ('shipped','delivered','reshipped')
  AND NOT EXISTS (SELECT 1 FROM shipment_items si WHERE si.shipment_id = s.id);
UPDATE shipments SET finalized_at = COALESCE(shipped_at, created_at)
WHERE status IN ('shipped','delivered','reshipped') AND finalized_at IS NULL;
-- (2) empty 'pending' placeholder rows from the old upsert-newest model
--     would read as abandoned drafts under the new lifecycle — remove them
WITH del AS (
  DELETE FROM shipments
  WHERE status = 'pending' AND tracking_number IS NULL AND shippo_rate_id IS NULL
  RETURNING id, order_id
)
INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
SELECT 'shipments', id::text, 'legacy_placeholder_removed', 'migration',
       jsonb_build_object('order_id', order_id)
FROM del;
