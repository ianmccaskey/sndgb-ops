# SND GB Ops — notes for agents and reviewers

UI Bakery app over the Neon database `snd-gb-ops`. There is no package.json or
tsconfig at the root: `src/` is what UI Bakery compiles. Action conventions
(datasource `SND GB DB`, `{{params.x}}`, `NULLIF` before every cast, one row per
write, advisory lock class 42001 per order wherever money moves) are in
`README.md`, as is the full "Storefront source" rule set.

## Settled product decisions — do not re-open in review

These were decided by the owner and are enforced as described. Flag a place
where the code fails to honour one; do not propose replacing the decision.

- **Tenant boundary is the server, not row-level security.** Members reach
  this database only through servers. The storefront's Node server (and its
  worker) connects with a privileged role; browsers never hold a connection,
  the Neon Data API is not enabled, and no client-side SQL exists. Every
  member-facing query in that app scopes by the Neon Auth session's
  `auth_user_id` in server code and takes the user from the session, never
  from the request body. Since `1790103600` (2026-11-08) the **P2 Seller
  Portal** (a UI Bakery app) is the one less-privileged connection: its role
  `p2_seller_portal` holds NO table privilege, only EXECUTE on the
  `storefront.portal_*` SECURITY DEFINER wrappers, each of which resolves the
  shop from UI Bakery's server-substituted `{{user.email}}` through
  `storefront.seller_operators` (`portal_resolve_seller`) and filters every
  row by that shop. That is the "less-privileged app role" this bullet named
  as the point to revisit RLS; it was revisited and RLS still binds to
  nothing, because the role reaches rows only through owner-run functions,
  which bypass RLS — the function boundary IS the tenant boundary for the
  portal. Revisit RLS if any role is ever given direct table access or the
  Data API is enabled. Settled with the owner 2026-11-08.
- **One implementation of the seller rules, two entry points**
  (`1790103600`). Every rule a shop operator can exercise — mark shipped /
  fix tracking / mark delivered, the draft-first Shippo label (a
  `store_shipments` row BEFORE the money POST, the label recorded and the
  order shipped in one call, a void that returns the order to paid only
  while its tracking is still that label's), listings and stock
  (compare-and-set), payout wallets, the ship-from address and the shop's
  OWN Shippo key — lives in a `storefront.shop_*(p_seller_id, p_actor, …)`
  core function (owner-only; P2 Collective Orders calls these for the
  organizer-run shops: P², PRT, Papa Porgy's, Paige's, flagged
  `sellers.managed_in_ops`), and the granted `portal_*(p_email, …)` wrapper
  only swaps the first argument. Every refusal RAISEs a plain sentence
  (`insufficient_privilege` identity, `invalid_parameter_value` + `HINT
  field:<name>` input, `no_data_found` not-yours, `object_not_in_prerequisite_state`
  stale/CAS); audit rows never carry the buyer's email, the ship-to, a label
  URL or a key; the buyer's email is never selected and the ship-to is NULL
  outside its 30-day window. `store_orders.carrier/tracking_number/shipped_at/status`
  stay the buyer-facing truth. Flag a new rule written in only one place, a
  `portal_*` function that does anything but resolve-and-delegate, or a
  grant to the portal role beyond those wrappers; do not propose RLS here.
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
  admin — house listings, seller creation and portal operators, store orders
  of the organizer-run shops, member verification status — belongs in the
  **P2 Collective Orders** app, even though some of those tables live in this
  database; member shops run their own orders in the **P2 Seller Portal**
  (`1790103600`). Selling is by invitation: the organizers create sellers in
  P2 Collective Orders, nobody applies. Settled with the owner 2026-10-08 and
  2026-11-08; do not add store pages here.
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

- **The ordering-app shipments pass acts only on hand marks with nothing
  recorded here.** `src/lib/autoAdopt.ts` (run by `AutoAdoptProvider`
  after every base44 import and when Fulfillment opens) pulls down what
  the other admin marked shipped by hand in base44. A base44 item's
  `shipped_date` format names its writer (ISO = this app's push, display
  text = base44's UI), and only hand marks are acted on: a local line with
  NO box, draft or adopted row is recorded through
  `adopt_upstream_shipment_untouched` (`1790103100`: the Adopt button's
  write behind a lock-held zero-attribution proof, so a mark is recorded
  at most once; one date, clamped quantity, fresh re-read first); a
  vendor-direct line whose whole quantity carries one usable mark is
  stamped through `markOrderDirectFulfilled` after the same re-read;
  lines already shipped here that base44 shows undated get their date
  written back (`pushShippedDatesUpstream`, trail line first, verified).
  It never records over a line that already has a box or draft here (a
  possible double shipment goes under "needs you" with both records),
  never acts on an order-level status alone, never resolves two dates.
  The write-back plans from one read, writes the local trail line, reads
  the order AGAIN with nothing awaited before the PUT and refuses if
  `updated_date`, status, notes or items moved; base44 has no conditional
  update, so the one network hop between that read and the PUT is the
  residual every upstream push in this app carries (`pushShipmentUpstream`
  included) — accepted, not a finding. Flag a place where the pass would
  record over local evidence, act on an ISO-dated item, or write upstream
  without the second read; do not propose widening it to order-level
  statuses or to linking products. Settled with the owner 2026-11-01.

- **A paid order ships even with a pending hash** (`1790102900`). The
  money gate on every pack/ship path (Ready and Direct queues, direct-ship
  candidates, the draft / manual / transfer functions, both purchase
  claims, transfer finalize) is `recon_status IN ('matched', 'over')`
  and not held — nothing else. Received counts only verified money (or
  the operator's override), so matched already means verified money
  covers what is due; a pending hash is shown (order sheet,
  Reconciliation, a "pending hash" badge on the Fulfillment row), never a
  gate. The write-off keeps its pending check: a write-off forgives money
  a pending hash may still be. Do not re-add `pending_payment_count = 0`
  to a ship gate. Settled with the owner 2026-10-28.

- **A box recorded shipped by mistake is cancelled at once; the label
  refund settles on its own** (`1790103200`). "Cancel shipment" on the
  Ship dialog (`cancelShipment` → `cancel_finalized_shipment()`, 42001
  lock) empties the finalized box (what it held stays in
  `cancelled_items` and the `shipment_cancelled` audit row), so its units
  are back on the pack list and in inventory now and the order re-enters
  Ready to pack; the Shippo refund stays a separate money fact on
  `refund_status`, requested and re-checked as before, and nothing waits
  for it. A cancelled box takes no items and its record never changes
  (triggers), and it is not a shipment: the queue, the order list, the
  delivery poll and every push surface skip `cancelled_at IS NOT NULL`,
  and `markShipmentPushed` refuses it. The cancel refuses a box the
  carrier reported moving / delivered / returned / failed, or the
  operator recorded delivered / reshipped (a return, not a cancel), and
  an adopted `'upstream'` record (corrected in the ordering app first, or
  auto-adopt records it again). Every write of an order's SHIP STATE to
  the ordering app — a box's push, a cancelled box's reset, the
  auto-adopt write-back — recomputes the whole order, so all three hold
  the ORDER's upstream lease (`upstreamLease` in `src/lib/pushShipment.ts`
  over `claim_order_upstream()` / `releaseOrderUpstream`,
  `order_upstream_leases`): claimed under 42001 BEFORE the writer reads
  what shipped here (a push's box must still be pushable), renewed right
  before the PUT (stamping `dispatched_at`; at most one sent write per
  order is unresolved), released on every ending — the dispatch only once
  the ordering app answered the PUT; an unanswered one
  (`B44UnreachableError`) holds for 10 minutes whatever a re-read shows.
  A cancel refuses while the order's lease or dispatch is fresh, so no
  write planned or sent before a cancel lands after its reset. Pass the
  lease deps and a `loadPackable` loader (never pre-read rows) to every
  such writer. The order-sheet payment pushers (tx refs, rail) also PUT
  `notes` but never items, dates or status; they are outside the lease
  and carry the house read-to-PUT residual. The ordering app is then
  reset for that one box (`resetVoidedShipmentUpstream`, also offered for
  a refund-voided pushed box): only ISO ship dates this app wrote, only
  on items no longer covered here, the box's tracking note marked
  cancelled, and status moved off shipped / partially_shipped only when
  this box's push evidently set it — to partially_shipped if anything
  else shipped, else the status the operator picks (default: the
  `prior_status` the push now records, else verified). Hand-typed dates
  and `delivered` are the other admin's and stay. Until
  `upstream_reset_at`, the row says "ordering app not reset" instead of
  offering "Record here" for the box that was cancelled. Settled with
  the owner 2026-11-01.

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
  every row (filled from the product by the `admin_adjustments_fill_campaign`
  trigger for every writer, `1790102400`), so campaign scoping never needs
  the product join; the `admin_adjustments_other_shape` CHECK keeps the two
  shapes apart. Every payout consumer adds `other_stock_usd` to
  `stock_cost_usd` as the group stock figure (`src/lib/payout.ts` callers).
  The vendor is paid for Other items through the payment batch: picking
  the item as a payment line writes a `vendor_payments` row with no
  product, kits or freight, attributed to that item
  (`admin_adjustment_id`, `1790102600`, so the item row reads as paid and
  the item cannot be deleted while the money is attributed); the lump
  "Other items $" field writes the same row attributed to no item. Both
  sit in `v_vendor_balances.other_paid_usd`, capped together like kits
  and freight; an item line beyond its own remaining refuses under the
  same vendor-level confirmation.
  `v_vendor_balances` (and the wallet-coverage owed query) are keyed by
  the union of product lines, Other adjustments and payments
  (`1790102500`), so a vendor stays visible while money is owed or paid
  even after its last product line moves. Settled with the owner
  2026-10-26. An Other item is corrected in place through
  `updateOtherAdjustment` → `update_other_adjustment()` (lock 42002 in its
  own statement, then name, qty, unit cost; `expected_usd`
  re-snapshots) when the vendor changed its price or count; refused once
  its sale was received or the vendor was already paid more than the new
  cost (remove the batch first). Vendor and assignment never change by
  edit.

- **A kit line's price is what the vendor charged** (`1790102800`). The
  campaign's unit cost is the PLAN (MOQ, `vendor_order_value_usd`, the
  kits still to buy, at-cost pricing); a payment line whose value differs
  from kits × the per-kit list cost records that difference, not a
  mistake: `record_vendor_payment_batch` snapshots
  `vendor_payments.list_value_usd` (kits × the blended per-kit list cost
  at record time) on every kit line it writes, and `amount − list value`
  is the product's `v_product_profit.price_variance_usd`, which its
  `owed_to_vendor_usd` and profit include — so `v_vendor_balances`, the
  wallet-coverage owed query and `v_group_buy_pnl` follow what was paid
  once every kit is bought. Variance is PRICE only, never quantity: an
  over-buy at list has none and is flagged as over-bought exactly as
  before. Rows recorded before the migration, freight / Other-items rows
  and the single rows the stock-plan commit and at-cost reallocation
  write carry NULL (no variance; the latter two's amount is cost +
  freight by design). Flag a reader that prices bought kits off the live
  unit cost instead of the line; do not propose editing
  `group_buy_products.unit_cost_usd` to match one batch. Settled with the
  owner 2026-10-28.

## Verifying changes

Serena's LSP diagnostics are the only type check. SQL actions are probed on
`snd-gb-ops` main inside a transaction that always rolls back (`BEGIN … ROLLBACK`,
or a `DO` block that raises); never leave probe rows behind. Every push needs a
clean Codex adversarial review at HEAD (`.git/codex-review-ok` holds the sha).
