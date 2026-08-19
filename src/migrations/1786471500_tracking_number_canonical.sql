-- Tracking numbers are canonicalized to UPPER (UPS-style numbers are
-- case-insensitive in practice): the write actions store
-- UPPER(TRIM(...)), and the active-uniqueness guard becomes an
-- EXPRESSION index so even a non-normalized write path cannot create
-- 1Z... and 1z... as two live packages for the same parcel. Same index
-- name — the client copy that explains the 23505 keeps working.
UPDATE inbound_packages SET tracking_number = UPPER(TRIM(tracking_number))
WHERE tracking_number <> UPPER(TRIM(tracking_number));
DROP INDEX inbound_packages_active_tracking_uniq;
CREATE UNIQUE INDEX inbound_packages_active_tracking_uniq
  ON inbound_packages (carrier, UPPER(tracking_number))
  WHERE received_at IS NULL;
