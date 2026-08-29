-- Package-contents photos: the operator photographs the open box before
-- shipping (phone camera capture) and the image attaches to the shipment
-- record as evidence of what went out. Images are client-side downscaled
-- and JPEG-compressed (target well under 500KB) and stored as data URLs;
-- the CHECK caps a row at ~1.5MB so an uncompressed original can never
-- land, and the LIKE guard in the action confines the payload to images.
-- ON DELETE CASCADE: photos follow their shipment (a deleted draft's
-- photos die with it; finalized shipments never delete — refunds only
-- void them, keeping the evidence).
CREATE TABLE shipment_photos (
  id bigserial PRIMARY KEY,
  shipment_id bigint NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  image_data text NOT NULL
    CONSTRAINT shipment_photos_size CHECK (length(image_data) BETWEEN 100 AND 1500000),
  created_by TEXT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipment_photos_shipment_idx ON shipment_photos (shipment_id);
