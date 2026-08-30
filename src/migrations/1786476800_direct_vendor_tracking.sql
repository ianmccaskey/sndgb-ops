-- Vendor-provided tracking for direct-ship lines (Ian: choose lines one
-- by one when marking vendor shipped and enter tracking for each
-- shipment). Distinct from the transfer-joined tracking (labels WE
-- bought, joined via direct_fulfilled_transfer_id): these columns hold
-- the VENDOR's label, entered at Vendor-shipped time. Set/cleared by
-- markOrderDirectFulfilled; canonical compact tracking (UPPER, no
-- whitespace), lowercase carrier token.
ALTER TABLE order_items
  ADD COLUMN direct_vendor_carrier text,
  ADD COLUMN direct_vendor_tracking text;
