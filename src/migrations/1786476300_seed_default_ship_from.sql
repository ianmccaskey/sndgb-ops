-- Reproducible seed of the app-wide default ship-from (Ian: "default
-- shipping info for Paige set default to Paige PMB 1"). Idempotent and
-- deferential: only fires when NO default exists yet, so on the live DB
-- (where the default was set with an audit row at feature time) it is a
-- no-op, while a fresh/restored environment converges on the same state.
WITH up AS (
  UPDATE receive_addresses SET is_default_ship_from = true
  WHERE label = 'Paige PMB 1' AND active
    AND NOT EXISTS (SELECT 1 FROM receive_addresses WHERE is_default_ship_from)
  RETURNING id, label
)
INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
SELECT 'receive_addresses', up.id::text, 'default_ship_from_set', 'migration',
       jsonb_build_object('label', up.label, 'seed', true)
FROM up;
