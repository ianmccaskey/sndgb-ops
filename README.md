# SND Group Buy Ops

UI Bakery Vibe app for running mixed-vendor group buys — the database-backed replacement for the GB4 Google Sheet. Two-admin internal tool (Ian + Paige); order intake stays in the external ordering app and is pasted into the Import page.

## Stack

- **UI Bakery Vibe project** (React 19 + Tailwind + Radix, `@uibakery/data` SQL actions) — pulled into UI Bakery from this repo, same workflow as `prtmgmt`.
- **Neon Postgres** — project `snd-gb-ops` (`flat-dream-33800739`), database `neondb`. Connect it in UI Bakery as datasource **`SND GB DB`** (the name is referenced by every action).
- **Moralis** (ETH + BASE) and **Helius** (SOL) for on-chain payment verification and wallet snapshots — keys are entered on the Settings page (stored in `app_settings`).

## Pages

| Page | What it replaces in the sheet |
|---|---|
| Dashboard | MOQ tracker totals + "where are we" glances |
| Orders | Orders tab (with per-order recon status inline) |
| Import | Manual copy-paste into the Orders tab — now parsed, validated, idempotent |
| Reconciliation | Both audit tabs — per-order and per-rail, plus on-chain Verify buttons |
| Vendors | Vendor payment tracking (OVERPAID is loud, vendors are dropdowns) |
| Products | Products/MOQ tab + Profit tab inputs + the opaque "Adjustments" column |
| Fulfillment | (new) pack/ship queue, tracking, reship costs |
| Financials | Profit tab summary + wallet balances + supplies (now actually in P&L) |
| Settings | Fees, tolerance, API keys, wallet addresses, profit split |

## Database

Schema lives in `src/migrations/` (already applied to Neon; tracked in `claude_migrations_applied`). All derived numbers are **views** (`v_moq_progress`, `v_product_profit`, `v_vendor_balances`, `v_order_reconciliation`, `v_rail_reconciliation`, `v_group_buy_pnl`) — nothing computed is ever stored, so nothing can go stale.

Key invariants:
- One quantity basis: `final_count = customer demand + audited admin adjustments`.
- Orders upsert on `order_number`; re-importing an export refreshes rather than duplicates.
- Payment overrides require a reason and are written to `audit_log`.
- Zip codes are text (leading zeros survive); states normalize to 2-letter codes at import.

### Storefront source (p2collective.app)

The P² Collective storefront owns schema `storefront` in this database and is imported like any other upstream (Import → "Refresh from storefront"): `listStorefrontOrders` → `mapStorefrontOrder` → the same `importUpsertOrder` / items / `importPayments` / cancellation actions base44 orders use. Settled rules, so reviewers don't re-open them:
- Storefront orders carry **no external id**; every base44-only control (push changes, rail push, deleted-upstream diff) stays hidden by the existing `external_id` gates.
- Storefront **payment claims** import on the rail they were made on (`ParsedPayment.method`), never the order header's. Claims in `pending`, `verified` and `mismatch` import — `mismatch` is a confirmed transfer to our wallet of a different amount, i.e. real money reconciliation must see; only `rejected` (failed on-chain, paid another wallet, never found) is not a payment and never imports. This app verifies every imported hash itself; the storefront's verdict is advisory. A claim the storefront rejects AFTER this app imported it pending — a tx hash or a cash receipt reference — is rejected here too on the next pull (`syncStorefrontRejectedClaims`, run for every pulled row — live, cancelled, or skipped by validation — BEFORE any payment imports; a release that fails aborts the whole run), never a row this app has verified itself.
- A **cancelled** storefront order can still hold a hash here that a live order now claims (its claim imported while it was live; this app keeps a hash on ONE order). On the next pull a *pending* local copy is released to the live claimant (`releaseCancelledStorefrontClaims`, audited `payment_released_cancelled_order`); a *verified* or *mismatch* copy is money this app saw land and is never moved by a pull — the live order’s import row turns red until an operator rejects or reassigns that payment by hand. The storefront itself refuses to cancel an order with a live claim, so this is the backstop for admin-side cancellations.
- **A hash that did not attach is never a green row.** `importPayments` reports every skipped hash with its holder; only "already on this same order, not rejected" is an idempotent re-import. A hash held by another order (live or cancelled) or rejected on this order leaves the order short, and its import row turns red naming the holder, so the operator rejects the wrong claim and pulls again. Duplicate claims are indexed across EVERY pulled row — live, cancelled, or skipped by validation — so an importable order that attaches a hash another row also claims gets its conflict note on the same pull, not after the other row is fixed.
- Cross-campaign invariants are database-enforced: an order pays only on an option of its own campaign on its own rail (`1790100100`), and carries only lines of its own campaign (`1790100200`).
- **Order numbers are unique across both writers** (`1790100300`): `public.order_number_registry` (primary key) is filled by `AFTER INSERT` triggers on `public.orders` and `storefront.orders`. A number the other side already holds fails the insert (`order_number_registry_pkey`) — for an import that is a red result row, never an overwrite. The one legitimate "shared" number is this app's imported copy of a storefront order (`raw_import.source = 'storefront'`), which reuses the storefront's claim instead of making a second one (`1790100500`) — and only after the trigger has found the storefront order with that number, campaign and id (`1790100600`); a "storefront copy" with no such row fails (`orders_storefront_copy_fk`). Order numbers are immutable on both tables (`1790100700`): a number is registered once, so a repair that needs a different number is a new order. `upsertStorefrontCampaign` also seeds a campaign's storefront sequence above every number this app holds, so the trigger is the backstop, not the normal path.
- "Paid" on the storefront is this app's reconciliation (`v_order_reconciliation.recon_status` matched/over); the storefront never marks an order paid from a shared-wallet hash on its own.
- **Tenant boundary is the storefront's server, not row-level security.** Only the storefront's Node server (and its worker) connects to this database, with a privileged role; browsers never hold a connection, the Neon Data API is not enabled, and no client-side SQL exists. Every member-facing query scopes by the Neon Auth session's `auth_user_id` in server code (`lib/customers`, `lib/orders`, `lib/payments`). RLS would not bind to anything in this topology (a privileged role bypasses it); it becomes the right tool if a less-privileged app role or the Data API is ever introduced, and that is the point to add it — not before.

## Import format

Paste tab-separated rows from the ordering app export (header row optional — columns are matched by name). Handles the `SKU (qty); …` items blob, pipe-delimited tx hashes / explorer URLs / PayPal receipts, and flags unknown SKUs before anything is written.

## Dev

```bash
cd src
bun install
bun run lint
bun x tsc --noEmit
```
