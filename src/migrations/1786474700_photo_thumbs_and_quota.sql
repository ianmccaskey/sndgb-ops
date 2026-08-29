-- Review hardening on 1786474600, read/write amplification + guards:
-- (1) THUMBNAIL-FIRST reads: shipment_photos gains thumb_data (a small
--     client-generated JPEG, capped ~80KB) — list views return ONLY
--     thumbnails; the full image loads on demand (getShipmentPhoto) when
--     the operator enlarges one. Added NOT NULL while the table is
--     provably empty (created this session, zero rows at execution).
-- (2) Per-shipment QUOTA (enforced in addShipmentPhoto's SQL): max 5
--     photos and ~5MB aggregate per shipment — a mistaken bulk select
--     cannot bloat a shipment past what its views can carry.
-- (3) deleteShipmentPhoto now requires the parent shipment_id to match
--     (integrity-guard convention): stale client state cannot delete
--     evidence from a different shipment than the operator is viewing.
ALTER TABLE shipment_photos ADD COLUMN thumb_data text NOT NULL
  CONSTRAINT shipment_photos_thumb_size CHECK (length(thumb_data) BETWEEN 100 AND 80000);
