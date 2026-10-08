-- The registry (1790100300–1790100600) claims numbers on INSERT. An UPDATE
-- of order_number would slip past it: the old number's claim goes stale and
-- the new one is never checked against the other writer. Nothing in either
-- app changes an order number — it is the identifier customers hold — so
-- make that a rule the database keeps: order_number is immutable on both
-- tables. A repair that truly needs a different number is a new order.
CREATE OR REPLACE FUNCTION public.order_number_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.order_number IS DISTINCT FROM OLD.order_number THEN
    RAISE EXCEPTION 'order_number is immutable (% → %): numbers are registered once across both writers; create a new order instead',
      OLD.order_number, NEW.order_number
      USING ERRCODE = 'check_violation', CONSTRAINT = 'order_number_immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS order_number_immutable ON public.orders;
CREATE TRIGGER order_number_immutable
  BEFORE UPDATE OF order_number ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.order_number_immutable();

DROP TRIGGER IF EXISTS order_number_immutable ON storefront.orders;
CREATE TRIGGER order_number_immutable
  BEFORE UPDATE OF order_number ON storefront.orders
  FOR EACH ROW EXECUTE FUNCTION public.order_number_immutable();
