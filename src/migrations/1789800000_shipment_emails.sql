-- Own shipment-notification emails (Ian, 2026-09-29): Shippo's tracking
-- emails never fire for API-purchased labels (the account's Orders tab is
-- empty — no Order objects, no notifications), so the app now sends its
-- own "your order has shipped" email via Resend at label finalize.
-- sent_at doubles as the send CLAIM (CAS: only one session may flip it
-- from NULL), so a recovery path re-running a finalize can never email
-- the customer twice. A failed send clears the claim and records the
-- error so the operator can retry from the shipment row.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_email_sent_at timestamptz;
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS tracking_email_error text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS tracking_email_sent_at timestamptz;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS tracking_email_error text;
