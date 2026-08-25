-- Durable transfer-side record of stamp SUCCESS. finalizeTransfer sets
-- transfers.direct_stamped_at (in the same statement, via a CTE gated
-- on the stamp CTE) only when the order line was ACTUALLY marked
-- fulfilled by THIS transfer. The order sheet's tracking join requires
-- it: a transfer that finalized with the stamp refused
-- (direct_stamped=0) can never later masquerade as the line's shipment
-- just because an admin manually marked the line fulfilled for some
-- other reason. Inferring stamp success from order_items'
-- direct_fulfilled_at alone was exactly that trap.

ALTER TABLE transfers ADD COLUMN direct_stamped_at TIMESTAMPTZ;
