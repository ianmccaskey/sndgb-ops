-- One receive address may be marked as the default ship-from for the
-- fulfillment Ship dialog (Ian: "default shipping info for Paige set
-- default to Paige PMB 1"). Partial unique index caps it at one row
-- app-wide; setDefaultShipFrom moves it atomically.
ALTER TABLE receive_addresses
  ADD COLUMN is_default_ship_from BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX receive_addresses_default_ship_from_uniq
  ON receive_addresses ((1)) WHERE is_default_ship_from;
