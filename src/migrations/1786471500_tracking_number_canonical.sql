-- Tracking numbers are canonicalized to UPPER (UPS-style numbers are
-- case-insensitive in practice): the write actions store
-- UPPER(TRIM(...)), and the active-uniqueness guard becomes an
-- EXPRESSION index so even a non-normalized write path cannot create
-- 1Z... and 1z... as two live packages for the same parcel. Same index
-- name — the client copy that explains the 23505 keeps working.
-- Preflight: refuse loudly if two ACTIVE rows differ only by case — they
-- are the same physical parcel and an operator must resolve which record
-- is real before canonicalization can collapse them. (This ran against a
-- verified-empty table on 2026-08-19; the guard documents the
-- precondition for any future re-use.)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM inbound_packages
    WHERE received_at IS NULL
    GROUP BY carrier, UPPER(tracking_number)
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'case-duplicate ACTIVE tracking rows exist — resolve them before canonicalizing';
  END IF;
END $$;
UPDATE inbound_packages SET tracking_number = UPPER(TRIM(tracking_number))
WHERE tracking_number <> UPPER(TRIM(tracking_number));
DROP INDEX inbound_packages_active_tracking_uniq;
CREATE UNIQUE INDEX inbound_packages_active_tracking_uniq
  ON inbound_packages (carrier, UPPER(tracking_number))
  WHERE received_at IS NULL;
