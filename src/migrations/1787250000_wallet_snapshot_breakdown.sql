-- Per-token breakdown on wallet snapshots (Ian, 2026-09-13): the balance
-- fetchers (Moralis/Helius) already return USDC/USDT/PYUSD/native
-- separately, but snapshots collapsed them to one stable total + native.
-- Keep the detail so Financials can show what each wallet actually holds.
-- Shape: {"usdc": n, "usdt": n, "pyusd": n, "native": n} — token units
-- (stables ≈ USD; native is ETH or SOL). NULL on rows from before this
-- column or from manual fiat entries.
ALTER TABLE wallet_snapshots ADD COLUMN IF NOT EXISTS breakdown jsonb;
