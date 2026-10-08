-- The Ops copy of a storefront order shares the storefront's number BY
-- DESIGN — it is the same order, imported for reconciliation. 1790100300's
-- trigger treated that insert into public.orders as a second claim on the
-- number and refused it, which would have blocked every first-time import
-- of a storefront order. The registry now distinguishes:
--   * storefront.orders inserts always claim the number as 'storefront';
--   * public.orders inserts whose raw_import says source = 'storefront'
--     reuse the storefront's claim (and must find one owned by 'storefront'
--     — a number owned by 'ops' is a genuine collision and still fails);
--   * every other public.orders insert (ordering app, paste) claims the
--     number as 'ops', failing if the storefront already holds it.
-- Collisions surface as unique_violation on order_number_registry_pkey,
-- the constraint both writers already treat as "taken".
CREATE OR REPLACE FUNCTION public.register_order_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  claimed_by TEXT;
BEGIN
  IF COALESCE(NEW.raw_import->>'source', '') = 'storefront' THEN
    SELECT source INTO claimed_by FROM public.order_number_registry WHERE order_number = NEW.order_number;
    IF claimed_by = 'storefront' THEN
      RETURN NEW;                       -- our copy of the storefront's order
    ELSIF claimed_by IS NULL THEN
      INSERT INTO public.order_number_registry (order_number, source) VALUES (NEW.order_number, 'storefront');
      RETURN NEW;                       -- registry predates this order's storefront row (should not happen; claim it for the storefront)
    END IF;
    RAISE unique_violation USING
      MESSAGE = format('order number %s is already held by the ordering app', NEW.order_number),
      CONSTRAINT = 'order_number_registry_pkey';
  END IF;
  INSERT INTO public.order_number_registry (order_number, source) VALUES (NEW.order_number, 'ops');
  RETURN NEW;
END $$;

-- the storefront side keeps the unconditional claim, as its own function so
-- neither trigger body references a column the other table lacks
CREATE OR REPLACE FUNCTION storefront.register_order_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.order_number_registry (order_number, source) VALUES (NEW.order_number, 'storefront');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS orders_register_number ON public.orders;
CREATE TRIGGER orders_register_number
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.register_order_number();

DROP TRIGGER IF EXISTS orders_register_number ON storefront.orders;
CREATE TRIGGER orders_register_number
  AFTER INSERT ON storefront.orders
  FOR EACH ROW EXECUTE FUNCTION storefront.register_order_number();
