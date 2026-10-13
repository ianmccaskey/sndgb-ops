-- Durable import-failure log (Ian, 2026-10-13): "We are getting a few
-- import failures. Id like a small area in the import screen that
-- isolates the import failures so they can be found and addressed."
-- Today a failed row exists only inside the run's in-memory results —
-- inline in a several-hundred-row preview table, keyed to the exact
-- input, gone on the next pull or a reload. This table is the
-- catch-basin: the runner records each failed row as it happens, the
-- Import page shows the OPEN ones in their own card, and a row closes
-- two ways — the operator resolves it by hand, or the same order later
-- imports clean and the run auto-resolves it (the natural "addressed"
-- signal, so the card never nags about fixed problems).
--
-- ONE open row per (campaign, order): a repeat failure updates the open
-- row (latest message, last_seen_at, seen_count) instead of stacking —
-- the card answers "what is broken NOW", the resolved history answers
-- "what was". Not money; no advisory lock needed (the partial unique
-- index arbitrates concurrent recorders).
CREATE TABLE IF NOT EXISTS import_failures (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  group_buy_id bigint NOT NULL REFERENCES group_buys(id),
  order_number text NOT NULL,
  message text NOT NULL,
  seen_count int NOT NULL DEFAULT 1 CHECK (seen_count > 0),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);

CREATE UNIQUE INDEX IF NOT EXISTS import_failures_open_uniq
  ON import_failures (group_buy_id, order_number)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS import_failures_gb_open_idx
  ON import_failures (group_buy_id)
  WHERE resolved_at IS NULL;
