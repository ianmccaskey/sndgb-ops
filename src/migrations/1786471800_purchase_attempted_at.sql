-- Split the purchase lease into two persisted states: purchase_started_at
-- remains the short-lived exclusivity/delete guard (stamped at draft
-- birth), while purchase_attempted_at is stamped ONLY by the pre-POST
-- heartbeat/claim (markTransferPurchaseStarted) — the durable marker that
-- a Shippo POST was actually dispatched and money may have moved. The
-- 30-day inventory reservation keys on purchase_attempted_at; a draft
-- created but never heartbeated (tab died before dispatch) or
-- definitively refused (both markers cleared) reserves only through the
-- 7-day rate-lifetime window on created_at.
ALTER TABLE transfers ADD COLUMN purchase_attempted_at timestamptz;

-- create_transfer_draft() was re-created (CREATE OR REPLACE, same
-- signature as 1786471700) with its reservation LATERAL changed to:
--   AND ((t.purchase_attempted_at IS NOT NULL AND t.purchase_attempted_at > now() - interval '30 days')
--        OR (t.purchase_attempted_at IS NULL AND t.created_at > now() - interval '7 days'))
-- (the draft INSERT still stamps only purchase_started_at, never
-- purchase_attempted_at).
