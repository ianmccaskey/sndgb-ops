-- A rejected payment documents a wrong attribution — it must not reserve the
-- hash forever. Real case: a tx imported onto the wrong order is rejected
-- there and must be attachable to the correct order. Uniqueness now applies
-- only to non-rejected rows; import/add paths guard with NOT EXISTS checks
-- (import: any status, so rejected hashes are never resurrected; manual add:
-- non-rejected only, so a rejected-elsewhere hash can move to the right order).
DROP INDEX IF EXISTS payments_tx_hash_uniq;
CREATE UNIQUE INDEX payments_tx_hash_uniq ON payments (tx_hash) WHERE tx_hash IS NOT NULL AND status <> 'rejected';
