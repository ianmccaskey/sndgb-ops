-- One Shippo transaction can back at most ONE transfer. The client's
-- recovery flows are rate-bound (a pasted transaction id must match the
-- draft's stored rate), but this index is the DB backstop: even a wrong
-- client can never attach the same purchased label to two transfers,
-- which would double-decrement inventory.
CREATE UNIQUE INDEX transfers_transaction_unique
  ON transfers (shippo_transaction_id)
  WHERE shippo_transaction_id IS NOT NULL;
