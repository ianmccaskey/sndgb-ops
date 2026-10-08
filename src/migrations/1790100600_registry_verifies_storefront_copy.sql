-- 1790100500 let a public.orders insert reuse a storefront registry claim
-- on the strength of its own raw_import JSON. JSON is not proof: a
-- malformed call could squat a number as storefront-owned, and the real
-- storefront insert would then fail. A storefront copy now has to BE a
-- storefront order — the row must exist with the same number, the same
-- campaign and the storefront id the import recorded — or the insert fails.
CREATE OR REPLACE FUNCTION public.register_order_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  claimed_by TEXT;
BEGIN
  IF COALESCE(NEW.raw_import->>'source', '') = 'storefront' THEN
    PERFORM 1
    FROM storefront.orders so
    WHERE so.order_number = NEW.order_number
      AND so.group_buy_id = NEW.group_buy_id
      AND so.id::text = COALESCE(NEW.raw_import->>'storefront_order_id', '');
    IF NOT FOUND THEN
      RAISE foreign_key_violation USING
        MESSAGE = format('order %s claims to be a storefront copy, but no storefront order with that number, campaign and id exists', NEW.order_number),
        CONSTRAINT = 'orders_storefront_copy_fk';
    END IF;
    SELECT source INTO claimed_by FROM public.order_number_registry WHERE order_number = NEW.order_number;
    IF claimed_by = 'storefront' THEN
      RETURN NEW;                       -- our copy of a verified storefront order
    ELSIF claimed_by IS NULL THEN
      -- the storefront row exists but predates the registry: claim it for the storefront
      INSERT INTO public.order_number_registry (order_number, source) VALUES (NEW.order_number, 'storefront');
      RETURN NEW;
    END IF;
    RAISE unique_violation USING
      MESSAGE = format('order number %s is already held by the ordering app', NEW.order_number),
      CONSTRAINT = 'order_number_registry_pkey';
  END IF;
  INSERT INTO public.order_number_registry (order_number, source) VALUES (NEW.order_number, 'ops');
  RETURN NEW;
END $$;
