-- Idempotency backstop for manual-label transfers: one physical label
-- is one shipment is one transfer, so a second manual row with the
-- same (carrier, tracking_number) is always a duplicate record — a
-- double-click that beat the client guard, or a retry after an
-- ambiguous timeout whose first attempt actually landed. The unique
-- index makes the duplicate unrepresentable; the client maps its
-- 23505 to "already recorded — check the transfer log". Scoped to
-- manual rows only (shippo_rate_id IS NULL): Shippo-bought rows carry
-- their own uniqueness through the rate id, and their tracking values
-- are Shippo-assigned, not operator-typed. Tracking is stored
-- canonical UPPER(TRIM) by create_manual_transfer, so case variants
-- collide as intended.
--
-- REPLAY GUARD: fail fast with instructions on a dirty copy. At live
-- apply time this was query-verified vacuous (zero rows with
-- shippo_rate_id IS NULL existed — the manual UI had never shipped).

DO $chk$
BEGIN
  IF EXISTS (
    SELECT 1 FROM transfers
    WHERE shippo_rate_id IS NULL AND tracking_number IS NOT NULL
    GROUP BY carrier, tracking_number HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate manual (carrier, tracking_number) transfers exist — deduplicate them before this migration';
  END IF;
END
$chk$;

CREATE UNIQUE INDEX transfers_manual_tracking_uniq
  ON transfers (carrier, tracking_number)
  WHERE shippo_rate_id IS NULL AND tracking_number IS NOT NULL;
