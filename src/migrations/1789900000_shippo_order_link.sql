-- Shippo Order linkage (Ian, 2026-09-29): Shippo support confirmed their
-- tracking notification emails only fire for labels tied to a Shippo
-- ORDER that gets fulfilled — raw API labels never qualify, which is why
-- 389 labels sent zero emails. The app now creates a Shippo Order (with
-- the customer's email) before each label purchase and passes its id
-- into the transaction; the order auto-flips to SHIPPED and Shippo's own
-- emails take over. The id is stored on the draft BEFORE money moves so
-- retry/recovery purchases reuse the same order instead of littering the
-- Shippo dashboard, and so the UI can show which boxes are covered.
ALTER TABLE shipments ADD COLUMN IF NOT EXISTS shippo_order_id text;
ALTER TABLE transfers ADD COLUMN IF NOT EXISTS shippo_order_id text;
