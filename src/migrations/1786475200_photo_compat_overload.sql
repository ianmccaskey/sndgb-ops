-- Compatibility overload for add_shipment_photo (Codex round 31,
-- finding 2).
--
-- 1786475100 dropped the 4-arg signature when adding p_replay. No
-- RELEASED client ever called the 4-arg contract (the photo feature has
-- not shipped), but the DB deliberately leads the repo here, and during
-- the dev/release window a stale tab or an intermediate bundle could
-- still hold the 4-arg wrapper — and rolling the app back to an
-- intermediate commit would otherwise require another schema change.
-- This thin SQL overload forwards to the 5-arg function with
-- p_replay = false (the old behavior: every add treated as deliberate),
-- so both contracts work until the old one is definitively drained.

CREATE OR REPLACE FUNCTION add_shipment_photo(
  p_shipment_id bigint,
  p_image_data  text,
  p_thumb_data  text,
  p_actor       text
) RETURNS TABLE (id bigint)
LANGUAGE sql AS $$
  SELECT * FROM add_shipment_photo(p_shipment_id, p_image_data, p_thumb_data, p_actor, false);
$$;
