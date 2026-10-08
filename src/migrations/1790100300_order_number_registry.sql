-- One order number, one owner, across BOTH writers.
--
-- public.orders (this app, fed by the ordering app and paste) and
-- storefront.orders (p2collective.app) each keep order_number unique within
-- their own table, and both mint the same YYYY-CODE-NNN shape. No lock the
-- two systems could share would be as cheap or as certain as a single
-- registry with a primary key: an AFTER INSERT trigger on each table claims
-- the number here in the same transaction, so a concurrent insert of the
-- same number on the other side blocks on the key and fails when the first
-- commits. Numbers are never released (a deleted order's number stays
-- taken), which is the intended behaviour for an identifier customers hold.
CREATE TABLE IF NOT EXISTS public.order_number_registry (
  order_number TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('ops', 'storefront')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- backfill: what exists today. Ops first: should a number already exist on
-- both sides (it must not, but a registry has to start somewhere), Ops is
-- the reconciliation truth and keeps it.
INSERT INTO public.order_number_registry (order_number, source)
SELECT order_number, 'ops' FROM public.orders
ON CONFLICT (order_number) DO NOTHING;

INSERT INTO public.order_number_registry (order_number, source)
SELECT order_number, 'storefront' FROM storefront.orders
ON CONFLICT (order_number) DO NOTHING;

CREATE OR REPLACE FUNCTION public.register_order_number() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- a conflict surfaces as unique_violation on order_number_registry_pkey,
  -- which both writers treat as "numbering collision — not placed/imported"
  INSERT INTO public.order_number_registry (order_number, source) VALUES (NEW.order_number, TG_ARGV[0]);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS orders_register_number ON public.orders;
CREATE TRIGGER orders_register_number
  AFTER INSERT ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.register_order_number('ops');

DROP TRIGGER IF EXISTS orders_register_number ON storefront.orders;
CREATE TRIGGER orders_register_number
  AFTER INSERT ON storefront.orders
  FOR EACH ROW EXECUTE FUNCTION public.register_order_number('storefront');
