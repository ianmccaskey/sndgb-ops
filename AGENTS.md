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
- **The assistant is read-only: it proposes, the operator applies.**
  `src/lib/assistant.ts` + `AskAssistant` explain records and draft text;
  its tools are read tools pinned to the selected campaign
  (`readAuditTrail`, `listOrderRecon`, and the Verify button's on-chain
  lookup `lookupTxPayment` without its write), a draft is text the
  operator pastes or a field they still submit, member fields are never
  sent (hand-picked facts, `redact()` over facts and tool results drops
  member-field keys and scrubs emails/phones/handles from strings; the
  tracking-email draft sends the first name only), and every question is
  audited (`assistant_asked`, question scrubbed). On the order sheet only
  it may also PROPOSE a crypto payment fix (`propose_fix`: verify, reject,
  undo rejection, re-open on another network, add hash, set override) — a
  card with an editable reason and an Apply button, nothing more. Apply is
  the operator's click: it runs the sheet's OWN handler for that control
  (same guards — reason required, status re-checked, one hash per order,
  this order's payments only), under the operator's name, and is audited
  again as `assistant_fix_applied`. Never give the model a write tool,
  never let a proposal apply without the click, and never automate the
  manual confirmations it explains — they are the safety design, not
  toil. The key lives on the `Anthropic API` datasource only. Settled
  with the owner 2026-10-13; proposals added at the owner's request
  2026-10-25.

- **Auto-reconcile acts only on what the chain settles.** The pass
  (`src/lib/autoRecon.ts`, run by `AutoReconProvider` after every import
  and when Reconciliation opens) verifies pending crypto hashes, re-points
  a pending hash to the ONE other network that shows it paying our wallet
  (`repointPendingPaymentNetwork`, evidence in the audit row), and corrects
  an order's rail through the shared `src/lib/railCorrection.ts` (the
  order sheet's button runs the same code). It never rejects, overrides,
  prices a native coin, moves a hash between orders, or touches a
  storefront order's rail (the mapper owns it) — those stay with the
  operator, listed under "needs you" where the assistant may propose them.
  Flag a place where the pass would act on ambiguous evidence (two
  networks, a hash another order holds); do not propose widening it to
  rejections or overrides. Settled with the owner 2026-10-25.

- **Group stock is funded equally by the partners, not by the profit

  split.** Stock-plan commits and group-stock adjustments sit inside
  `v_group_buy_pnl.net_profit_usd`, but a party's payout is
  `pct × (net + group stock) − group stock / N − personal deductions`
  (`src/lib/payout.ts`, used by the Financials overview, the Dispersion
  tab and the dashboard — never re-derive it inline). N is the number of
  split parties, so 50/50 today. Settled with the owner 2026-10-24.

- **A COA product is digital, with no freight and no testing cost of its
  own** (`1790102000`): "COA - <sku>" rows are flagged digital on insert
  whatever the writer passed (the ordering-app sync passes nothing), an
  update that would make one physical is refused, and a COA campaign line
  with testing cost or freight is refused with the reason. A COA is a
  digital copy of a lab report; the product it certifies carries the
  testing cost. Settled with the owner 2026-10-25.

- **A vendor payment is one batch: product lines plus the sends that
  carried the money, on any mix of rails** (`1790102100`). The Vendors
  page records through `addVendorPaymentBatch` → `record_vendor_payment_batch()`
  (`1790102200`, plpgsql so the 42002 lock is its own statement and the
  cap reads see every earlier batch) only: lines (kits and $
  per product) and freight say what was bought, sends (wallet, amount,
  token, tx ref) say which wallet each transfer left from, and the batch
  inserts whole or not at all with every refusal named. A batched line
  carries no wallet (CHECK) — its money is on its sends — and the
  deferred trigger `vendor_payment_batch_balanced` keeps sends equal to
  lines for every writer, so a batch is removed only as a whole
  (`deleteVendorPaymentBatch`, audited with every row). Kits and freight
  owed keep reading the LINES (`v_vendor_balances`, per-product
  progress, the kit caps); money out of a wallet reads
  `v_vendor_outflows` (unbatched rows with a wallet, plus every send) —
  never `vendor_payments.wallet_id` directly. The stock-plan commit and
  the at-cost reallocation still write single unbatched rows. Settled
  with the owner 2026-10-26.

- **An "Other" admin adjustment is an at-cost purchase of something the
  campaign does not sell** (`1790102300`): a typed name, unit vendor cost
  and one of the campaign's vendors instead of a `group_buy_product_id`,
  written only by `addOtherAdjustment`. It takes the same three at-cost
  assignments a product row can (party → that party's payout; both +
  stock → net profit via `v_group_buy_pnl.other_stock_usd`, funded equally
  by the partners; both → an outside-customer receivable), and the vendor
  is owed qty × cost (`v_vendor_balances.other_owed_usd`, inside
  `owed_usd`). It adds NO demand, MOQ, kits, freight or testing cost — the
  typed cost is the landed cost. `admin_adjustments.group_buy_id` is now on
  every row, so campaign scoping never needs the product join; the
  `admin_adjustments_other_shape` CHECK keeps the two shapes apart. Every
  payout consumer adds `other_stock_usd` to `stock_cost_usd` as the group
  stock figure (`src/lib/payout.ts` callers). Settled with the owner
  2026-10-26.

## Verifying changes

Serena's LSP diagnostics are the only type check. SQL actions are probed on
`snd-gb-ops` main inside a transaction that always rolls back (`BEGIN … ROLLBACK`,
or a `DO` block that raises); never leave probe rows behind. Every push needs a
clean Codex adversarial review at HEAD (`.git/codex-review-ok` holds the sha).
