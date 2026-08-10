-- EVM tx hashes are hex: identity is case-insensitive, so store them in
-- canonical lowercase (checksum-cased copies of the same tx must not read as
-- different payments). Solana signatures are base58 (case-significant) and
-- don't match this pattern, so they're untouched. Parser and manual-add paths
-- lowercase EVM hashes from this point on.
UPDATE payments SET tx_hash = lower(tx_hash)
WHERE tx_hash ~ '^0x[0-9a-fA-F]{64}$' AND tx_hash <> lower(tx_hash);
