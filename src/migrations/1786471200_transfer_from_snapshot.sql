-- Transfers must carry their SHIP-FROM snapshot like they carry the
-- destination: the label was bought against the address as it existed at
-- purchase time, and editing a receive address later must not rewrite
-- history. Backfilled from the current addresses (the best data that
-- exists for old rows).
ALTER TABLE transfers ADD COLUMN from_label TEXT;
ALTER TABLE transfers ADD COLUMN from_address jsonb;
UPDATE transfers t
SET from_label = ra.label,
    from_address = jsonb_build_object(
      'name', ra.name, 'street1', ra.street1, 'street2', ra.street2,
      'city', ra.city, 'state', ra.state, 'zip', ra.zip,
      'country', ra.country, 'phone', ra.phone, 'email', ra.email)
FROM receive_addresses ra
WHERE ra.id = t.from_address_id;
