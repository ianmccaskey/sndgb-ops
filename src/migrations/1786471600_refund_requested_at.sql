-- When the REQUESTING refund marker was stamped. The reconcile flow may
-- only CLEAR a REQUESTING marker older than 10 minutes: a fresher one may
-- belong to another session whose Shippo POST is still in flight (the
-- refund would not be listed yet), and clearing it would re-enable a
-- duplicate refund request.
ALTER TABLE transfers ADD COLUMN refund_requested_at timestamptz;
