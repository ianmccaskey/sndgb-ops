-- Carrier tracking snapshots on ORDER shipments (Ian, 2026-09-22: "show
-- when a shipment is delivered to customer in the shipment tab").
-- Mirrors inbound_packages' tracking columns: the carrier's word lives
-- here (refreshed from Shippo on demand); shipments.status stays the
-- operator/push state machine — the two are deliberately separate truths.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_status text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_substatus text;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_status_date timestamptz;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_checked_at timestamptz;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_error text;
