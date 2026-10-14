-- Seller branding for the store's "hall" (Ian, 2026-10-14): the store becomes
-- an ecosystem of storefronts (P², PRT, El Peppy Joe's, Papa Porgy's
-- Emporium, Princess Paige's Pantry …), each shown as a banner with its logo
-- or an animated character, a one-line tagline and a gold-family accent.
-- Branding is self-serve: an approved seller sets it on their dashboard in
-- p2collective-app. The house (P²) has no sign-in; its banner defaults to the
-- bundled P² mark and the organizers set the rest here by hand if wanted.
--
-- Writes go through two SECURITY DEFINER functions rather than column grants.
-- The least-privilege storefront role (1790101500, not yet applied) revokes
-- UPDATE on storefront.sellers and keeps storefront.media read-only, and a
-- later REVOKE on the table would also drop any column grant made here. The
-- functions run as their owner, scope by the caller-supplied auth user id
-- (which the storefront server takes from the session, never the request),
-- accept only an APPROVED individual seller, and only the columns below.
--
-- Columns are nullable and additive: existing readers are unaffected.

ALTER TABLE storefront.sellers
  ADD COLUMN IF NOT EXISTS tagline text,
  ADD COLUMN IF NOT EXISTS accent text,
  ADD COLUMN IF NOT EXISTS emblem_media_id bigint REFERENCES storefront.media(id),
  ADD COLUMN IF NOT EXISTS mascot_media_id bigint REFERENCES storefront.media(id),
  ADD COLUMN IF NOT EXISTS sort_order int;

DO $$ BEGIN
  ALTER TABLE storefront.sellers ADD CONSTRAINT sellers_tagline_len
    CHECK (tagline IS NULL OR (char_length(tagline) BETWEEN 1 AND 80 AND tagline = btrim(tagline)));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  -- the gold family only; the storefront maps each name to a token
  ALTER TABLE storefront.sellers ADD CONSTRAINT sellers_accent_known
    CHECK (accent IS NULL OR accent IN ('gold','gold_bright','gold_deep','foil','parchment'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- emblem = a logo (png/webp); mascot = an animated character (webm, mp4/mov, Lottie json)
ALTER TYPE storefront.media_kind ADD VALUE IF NOT EXISTS 'emblem';
ALTER TYPE storefront.media_kind ADD VALUE IF NOT EXISTS 'mascot';

-- Tagline and accent, for the approved seller signed in as p_auth_user_id.
-- Returns the seller id, or raises when the caller is not an approved seller.
CREATE OR REPLACE FUNCTION storefront.set_seller_branding(p_auth_user_id uuid, p_tagline text, p_accent text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, storefront
AS $fn$
DECLARE v_id bigint;
BEGIN
  UPDATE storefront.sellers
     SET tagline = NULLIF(btrim(p_tagline), ''),
         accent = NULLIF(p_accent, ''),
         updated_at = now()
   WHERE auth_user_id = p_auth_user_id AND kind = 'individual' AND status = 'approved'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not an approved seller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_id;
END
$fn$;

-- Record an uploaded emblem or mascot and point the seller at it. The object
-- key must sit under the seller's own prefix (sellers/<id>/<slot>/…), which the
-- storefront server builds; the previous media row stays (orders never point
-- at it, but a cached page may still show it for a few seconds).
CREATE OR REPLACE FUNCTION storefront.attach_seller_media(p_auth_user_id uuid, p_slot text, p_spaces_key text, p_mime text, p_bytes bigint, p_width int, p_height int)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, storefront
AS $fn$
DECLARE v_seller bigint; v_media bigint;
BEGIN
  IF p_slot NOT IN ('emblem','mascot') THEN
    RAISE EXCEPTION 'unknown media slot %', p_slot USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT id INTO v_seller FROM storefront.sellers
   WHERE auth_user_id = p_auth_user_id AND kind = 'individual' AND status = 'approved'
   FOR UPDATE;
  IF v_seller IS NULL THEN
    RAISE EXCEPTION 'not an approved seller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_spaces_key IS NULL OR position(('sellers/' || v_seller || '/' || p_slot || '/') IN p_spaces_key) <> 1 OR p_spaces_key LIKE '%..%' THEN
    RAISE EXCEPTION 'media key outside the seller prefix' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO storefront.media (owner_auth_user_id, kind, spaces_key, mime, bytes, width, height)
  VALUES (p_auth_user_id, p_slot::storefront.media_kind, p_spaces_key, p_mime, p_bytes, p_width, p_height)
  RETURNING id INTO v_media;
  IF p_slot = 'emblem' THEN
    UPDATE storefront.sellers SET emblem_media_id = v_media, updated_at = now() WHERE id = v_seller;
  ELSE
    UPDATE storefront.sellers SET mascot_media_id = v_media, updated_at = now() WHERE id = v_seller;
  END IF;
  RETURN v_media;
END
$fn$;

-- Clear an emblem or mascot (back to the monogram).
CREATE OR REPLACE FUNCTION storefront.clear_seller_media(p_auth_user_id uuid, p_slot text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, storefront
AS $fn$
DECLARE v_id bigint;
BEGIN
  IF p_slot NOT IN ('emblem','mascot') THEN
    RAISE EXCEPTION 'unknown media slot %', p_slot USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE storefront.sellers
     SET emblem_media_id = CASE WHEN p_slot = 'emblem' THEN NULL ELSE emblem_media_id END,
         mascot_media_id = CASE WHEN p_slot = 'mascot' THEN NULL ELSE mascot_media_id END,
         updated_at = now()
   WHERE auth_user_id = p_auth_user_id AND kind = 'individual' AND status = 'approved'
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'not an approved seller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_id;
END
$fn$;
