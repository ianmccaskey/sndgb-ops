-- The order line records WHICH transfer owns its current direct
-- fulfillment. finalizeTransfer's stamp sets it; the manual
-- "Vendor shipped" mark leaves it NULL (no transfer owns a manual
-- fulfillment); the manual UNDO clears it along with
-- direct_fulfilled_at. The order sheet's tracking join goes through
-- THIS pointer, so a stamped-then-undone transfer can never resurface
-- as the line's shipment after a later manual re-fulfill — tracking
-- shows only while the fulfillment's owner is that exact transfer.
-- (transfers.direct_stamped_at remains as the transfer-side audit
-- record; this pointer is the line-side ownership record.)
--
-- Same release, no schema needed: campaign consistency is re-proven at
-- claim AND stamp time via the line's own group_buy_products row
-- (o.group_buy_id = gbp.group_buy_id) — an order reassigned to a
-- different buy after draft creation mismatches its line's gbp and
-- refuses, closing the campaign-bound invariant at the irreversible
-- stages without persisting anything.

ALTER TABLE order_items ADD COLUMN direct_fulfilled_transfer_id BIGINT REFERENCES transfers(id);
