-- Lock down the seller-branding functions from 1790101600 (Codex review,
-- 2026-10-14). Postgres grants EXECUTE on a new function to PUBLIC, and these
-- run as their owner and trust the auth user id they are given, so any role
-- that can reach the storefront schema could rewrite another seller's
-- branding. Only the storefront server may call them: today it connects as
-- the owner (who keeps EXECUTE), and once the least-privilege role exists
-- (1790101500) it gets EXECUTE explicitly — here if it already exists, and in
-- 1790101500 itself if that is applied later.

REVOKE EXECUTE ON FUNCTION storefront.set_seller_branding(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.attach_seller_media(uuid, text, text, text, bigint, int, int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION storefront.clear_seller_media(uuid, text) FROM PUBLIC;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p2_storefront') THEN
    GRANT EXECUTE ON FUNCTION storefront.set_seller_branding(uuid, text, text) TO p2_storefront;
    GRANT EXECUTE ON FUNCTION storefront.attach_seller_media(uuid, text, text, text, bigint, int, int) TO p2_storefront;
    GRANT EXECUTE ON FUNCTION storefront.clear_seller_media(uuid, text) TO p2_storefront;
  END IF;
END $$;
