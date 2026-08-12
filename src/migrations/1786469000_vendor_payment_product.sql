-- Vendor payments attribute their kits to a SPECIFIC campaign product:
-- group_buy_product_id (nullable — freight-only or unattributed money needs
-- no product). The Vendors page breaks each vendor down into per-product
-- rows (kits demand vs kits paid per SKU), and the payment form constrains
-- the product choice to the selected vendor's campaign products.
--
-- Kits without a product are no longer accepted by addVendorPayment: the
-- per-product ledger is the point, and an unattributed kit count would be
-- invisible in it while still reducing the vendor-level remainder.

ALTER TABLE vendor_payments ADD COLUMN group_buy_product_id BIGINT REFERENCES group_buy_products(id);

-- Remediate any unattributed kit counts BEFORE the CHECK below: on the
-- production database there were ZERO vendor_payments rows at migration
-- time (kits_qty shipped in this same release cycle), but a replay against
-- another database must not fail the CHECK or silently lose data — the
-- legacy kit count is preserved verbatim in the row's note for manual
-- re-attribution.
UPDATE vendor_payments
SET note = COALESCE(note || ' | ', '') || 'legacy kits_qty ' || kits_qty || ' cleared by migration 1786469000 (was unattributed — re-record against a product)',
    kits_qty = NULL
WHERE kits_qty IS NOT NULL AND group_buy_product_id IS NULL;

-- DB-level invariant, not just action behavior: kit counts without a product
-- would be invisible in the per-product ledger while still consuming the
-- vendor-level remainder — no writer may create that state.
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_kits_require_product
  CHECK (kits_qty IS NULL OR group_buy_product_id IS NOT NULL);

-- Composite FK: a product-attributed payment must match the product's
-- CURRENT campaign and vendor — enforced by the database, not just action
-- guards, so a payment insert and a concurrent vendor reassignment cannot
-- interleave into a mismatched ledger (the reassignment would violate this
-- FK and fail). NULL group_buy_product_id rows (freight-only money) are
-- exempt per SQL MATCH SIMPLE semantics.
ALTER TABLE group_buy_products ADD CONSTRAINT group_buy_products_id_gb_vendor_uniq
  UNIQUE (id, group_buy_id, vendor_id);
ALTER TABLE vendor_payments ADD CONSTRAINT vendor_payments_product_vendor_fk
  FOREIGN KEY (group_buy_product_id, group_buy_id, vendor_id)
  REFERENCES group_buy_products (id, group_buy_id, vendor_id);
