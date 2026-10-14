-- The database enforces the seller-media contract itself (Codex review,
-- 2026-10-14). attach_seller_media is the only write path into
-- storefront.media for sellers, so it now refuses anything the storefront's
-- own checks (lib/store/hall-rules.ts) would refuse, rather than trusting
-- them: per-slot type allowlist, byte cap, key extension matching the type,
-- and sane pixel bounds. Logo = PNG or WebP up to 1 MB. Character = PNG/APNG,
-- WebP, GIF, WebM, MP4 or MOV up to 4 MB (Lottie was dropped: it needs a
-- runtime library and a CSP change). SVG is never accepted. CREATE OR
-- REPLACE keeps the function's privileges from 1790101700.

CREATE OR REPLACE FUNCTION storefront.attach_seller_media(p_auth_user_id uuid, p_slot text, p_spaces_key text, p_mime text, p_bytes bigint, p_width int, p_height int)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, storefront
AS $fn$
DECLARE
  v_seller bigint;
  v_media bigint;
  v_ext text;
  v_max bigint;
BEGIN
  IF p_slot NOT IN ('emblem','mascot') THEN
    RAISE EXCEPTION 'unknown media slot %', p_slot USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- the extension each accepted type must carry in its key
  v_ext := CASE p_mime
    WHEN 'image/png' THEN 'png'
    WHEN 'image/webp' THEN 'webp'
    WHEN 'image/gif' THEN 'gif'
    WHEN 'video/webm' THEN 'webm'
    WHEN 'video/mp4' THEN 'mp4'
    WHEN 'video/quicktime' THEN 'mov'
  END;
  IF v_ext IS NULL
     OR (p_slot = 'emblem' AND p_mime NOT IN ('image/png','image/webp')) THEN
    RAISE EXCEPTION 'type % not accepted for %', p_mime, p_slot USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_max := CASE p_slot WHEN 'emblem' THEN 1048576 ELSE 4194304 END;
  IF p_bytes IS NULL OR p_bytes <= 0 OR p_bytes > v_max THEN
    RAISE EXCEPTION 'size % out of range for %', p_bytes, p_slot USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF (p_width IS NOT NULL AND (p_width < 1 OR p_width > 8192))
     OR (p_height IS NOT NULL AND (p_height < 1 OR p_height > 8192)) THEN
    RAISE EXCEPTION 'dimensions out of range' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT id INTO v_seller FROM storefront.sellers
   WHERE auth_user_id = p_auth_user_id AND kind = 'individual' AND status = 'approved'
   FOR UPDATE;
  IF v_seller IS NULL THEN
    RAISE EXCEPTION 'not an approved seller' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- sellers/<id>/<slot>/<uuid>.<ext>, exactly
  IF p_spaces_key IS NULL
     OR p_spaces_key !~ ('^sellers/' || v_seller || '/' || p_slot || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.' || v_ext || '$') THEN
    RAISE EXCEPTION 'media key does not match the seller, slot and type' USING ERRCODE = 'invalid_parameter_value';
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
