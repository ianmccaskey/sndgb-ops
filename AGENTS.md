# SND GB Ops — notes for agents and reviewers

UI Bakery app over the Neon database `snd-gb-ops`. There is no package.json or
tsconfig at the root: `src/` is what UI Bakery compiles. Action conventions
(datasource `SND GB DB`, `{{params.x}}`, `NULLIF` before every cast, one row per
write, advisory lock class 42001 per order wherever money moves) are in
`README.md`, as is the full "Storefront source" rule set.

## Settled product decisions — do not re-open in review

These were decided by the owner and are enforced as described. Flag a place
where the code fails to honour one; do not propose replacing the decision.

- **Tenant boundary is the storefront's server, not row-level security.**
  Only the storefront's Node server (and its worker) connects to this database,
  with a privileged role; browsers never hold a connection, the Neon Data API is
  not enabled, and no client-side SQL exists. Every member-facing query in that
  app scopes by the Neon Auth session's `auth_user_id` in server code and takes
  the user from the session, never from the request body. RLS would bind to
  nothing in this topology (a privileged role bypasses it); it becomes the right
  tool if a less-privileged app role or the Data API is ever introduced, and
  that is the point to add it — not before.
- **The storefront is another upstream.** Its orders import through the same
  `importUpsertOrder` / items / `importPayments` / cancellation path base44
  orders use; this app verifies every hash itself and the storefront's verdict
  is advisory. "Paid" on the storefront is this app's reconciliation.
- **Order numbers are unique across both writers** by the
  `public.order_number_registry` triggers (`1790100300`…`1790100700`); numbers
  are immutable; the registry is never written by hand.
- **A hash is held by ONE order here.** Duplicate storefront claims are indexed
  across every pulled row; the order that attaches the hash gets a conflict
  note, every other claimant's import row turns red naming the holder, and a
  pull never moves money this app has verified (`verified` / `mismatch`).
- **An order reconciles on the rail its money sits on.** For storefront
  orders the mapper sets `payment_rail` from the live claims (confirmed first);
  a single claim rail wins over the checkout header, several rails turn the
  import row red. Rail cards key on `orders.payment_rail` by design.
- **Rejected claims are released before any payment imports**, for every
  pulled row (live, cancelled, or skipped by validation); a release that fails
  aborts the run before anything is written.
- **This app sets up CAMPAIGNS for p2collective.app; it never runs the P² store.**
  The nav entry is "Campaign Setup" (route `/storefront`, files under
  `src/app/pages/storefront/` — names kept, label changed): order-number code,
  payment options, published flag, import stats. Campaign-side admin that
  follows (COA reports for campaign products, polls) belongs here too. Store
  admin — house listings, seller applications and approval, store orders,
  member verification status — belongs in the **P2 Collective Orders** app,
  even though some of those tables live in this database. Settled with the
  owner 2026-10-08; do not add store pages here.
- **A campaign runs on ONE ordering platform** (`1790101100`): the database
  refuses storefront settings on a base44-linked campaign or one with other-
  source orders, refuses linking a storefront campaign to base44, and refuses
  a non-storefront order in a storefront campaign; Campaign Setup and
  `linkGroupBuyExternal` refuse first and say why. The storefront is for NEW
  campaigns.
- **Direct ship is routing only** (no customer surcharge); **split-kit fees are
  per-line snapshots**; **cash processor fee is a true gross-up** defined by
  the storefront and imported as stated.

## Verifying changes

Serena's LSP diagnostics are the only type check. SQL actions are probed on
`snd-gb-ops` main inside a transaction that always rolls back (`BEGIN … ROLLBACK`,
or a `DO` block that raises); never leave probe rows behind. Every push needs a
clean Codex adversarial review at HEAD (`.git/codex-review-ok` holds the sha).
