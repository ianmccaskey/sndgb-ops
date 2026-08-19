-- 1) Manual un-receive must STICK: auto-receive on DELIVERED would
--    otherwise silently re-receive the package on the next refresh.
--    unmarkPackageReceived sets this; auto-mode markPackageReceived
--    refuses while it is set; a MANUAL receive clears it.
ALTER TABLE inbound_packages ADD COLUMN auto_receive_suppressed boolean NOT NULL DEFAULT false;

-- 2) Purchase lease on transfer drafts: set at draft creation and by
--    every retry-purchase BEFORE the Shippo POST. deleteTransferDraft
--    refuses while the lease is fresh (< 10 minutes), so a concurrent
--    admin can never delete the draft in the window where a label
--    purchase may be in flight — the draft's rate id is the only
--    recovery handle for a paid label.
ALTER TABLE transfers ADD COLUMN purchase_started_at timestamptz;
