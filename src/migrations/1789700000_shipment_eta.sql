-- Carrier ETA on order shipments (Ian, 2026-09-23): the Check-deliveries
-- poll already fetched Shippo's expected delivery date and discarded it.
-- Stored alongside the other tracking snapshot fields, same error-
-- preserving write rules.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS eta timestamptz;
