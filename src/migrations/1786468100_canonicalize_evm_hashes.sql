-- EVM tx hashes are hex: identity is case-insensitive, so store them in
-- canonical lowercase (checksum-cased copies of the same tx must not read as
-- different payments). Solana signatures are base58 (case-significant) and
-- don't match this pattern, so they're untouched. Parser and manual-add paths
-- lowercase EVM hashes from this point on.

-- Preflight: the old exact-text index allowed the SAME EVM tx to exist twice
-- in different casing. Lowercasing those would collide with the non-rejected
-- unique index, so first keep the earliest copy and auto-reject later ones
-- (audited in notes) — they are one transaction, not two payments.
-- Survivor = the most trustworthy copy, not the oldest: verified first, then
-- verified_at recency, then earliest id. Rejecting a verified row in favor of
-- a pending one would un-pay an order purely by insertion order.
WITH dupes AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY lower(tx_hash)
    ORDER BY (status = 'verified') DESC, verified_at ASC NULLS LAST, id ASC
  ) AS rn
  FROM payments
  WHERE tx_hash ~ '^0x[0-9a-fA-F]{64}$' AND status <> 'rejected'
)
UPDATE payments p
SET status = 'rejected',
    notes = COALESCE(p.notes || ' | ', '') || 'auto-rejected: duplicate casing of the same EVM tx (canonicalization migration)'
FROM dupes d
WHERE d.id = p.id AND d.rn > 1;

UPDATE payments SET tx_hash = lower(tx_hash)
WHERE tx_hash ~ '^0x[0-9a-fA-F]{64}$' AND tx_hash <> lower(tx_hash);
