-- Enforce canonical hash identity at the database boundary: uniqueness keys
-- on lower(tx_hash) for EVM-shaped hashes (hex, case-insensitive identity)
-- and the verbatim value otherwise (Solana base58 is case-significant).
-- Rejected rows stay exempt (they document wrong attributions). Write paths
-- also canonicalize in SQL, but this index is what makes the invariant hold
-- for ANY caller.
DROP INDEX IF EXISTS payments_tx_hash_uniq;
CREATE UNIQUE INDEX payments_tx_hash_uniq ON payments (
  (CASE WHEN tx_hash ~ '^0x[0-9a-fA-F]{64}$' THEN lower(tx_hash) ELSE tx_hash END)
) WHERE tx_hash IS NOT NULL AND status <> 'rejected';
