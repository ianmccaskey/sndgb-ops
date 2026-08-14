-- Per-item direct-ship-from-vendor flag, pulled from the ordering app's
-- wants_direct_ship item field (and editable locally). direct_ship_source
-- records who set it: 'upstream' rows are refreshed by every pull, 'manual'
-- rows are operator overrides that imports must never clobber.
--
-- No backfill: the campaign is live and every pull re-upserts all items,
-- so the first pull after deploy populates the flags from upstream.

ALTER TABLE order_items ADD COLUMN direct_ship BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE order_items ADD COLUMN direct_ship_source TEXT NOT NULL DEFAULT 'upstream'
  CHECK (direct_ship_source IN ('upstream', 'manual'));

-- Direct lines carry their own completion state, independent of the order's
-- local shipment row: a MIXED order's local half can pack and ship while the
-- vendor half is still owed — without this, saving the local shipment would
-- drop the order out of every actionable queue with vendor work outstanding.
ALTER TABLE order_items ADD COLUMN direct_fulfilled_at TIMESTAMPTZ;
