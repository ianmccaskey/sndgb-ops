-- Per-unit shipping weight for the product catalog. Feeds the fulfillment
-- shipping modal's box-weight prefill (sum of packed qty x unit_weight_oz,
-- + the default_box_tare_oz setting). NULL = unknown: the prefill counts
-- the line as 0 and the modal lists which SKUs lack a weight, so a wrong
-- auto-weight is never silently plausible. Ounces because kit weights are
-- small and the Shippo parcel converts to lb at quote time.
-- NOT the same thing as mass_label, which is a peptide DOSE label ('60mg').
ALTER TABLE products ADD COLUMN unit_weight_oz NUMERIC(8,2)
  CONSTRAINT products_weight_nonneg CHECK (unit_weight_oz IS NULL OR unit_weight_oz >= 0);
