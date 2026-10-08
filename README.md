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
- Storefront **payment claims** import on the rail they were made on (`ParsedPayment.method`), never the order header's. Claims in `pending`, `verified` and `mismatch` import — `mismatch` is a confirmed transfer to our wallet of a different amount, i.e. real money reconciliation must see; only `rejected` (failed on-chain, paid another wallet, never found) is not a payment and never imports. This app verifies every imported hash itself; the storefront's verdict is advisory.
- Cross-campaign invariants are database-enforced: an order pays only on an option of its own campaign on its own rail (`1790100100`), and carries only lines of its own campaign (`1790100200`).
- **Order numbers are unique across both writers** (`1790100300`): `public.order_number_registry` (primary key) is filled by `AFTER INSERT` triggers on `public.orders` and `storefront.orders`. A number the other side already holds fails the insert (`order_number_registry_pkey`) — for an import that is a red result row, never an overwrite. `upsertStorefrontCampaign` also seeds a campaign's storefront sequence above every number this app holds, so the trigger is the backstop, not the normal path.
- "Paid" on the storefront is this app's reconciliation (`v_order_reconciliation.recon_status` matched/over); the storefront never marks an order paid from a shared-wallet hash on its own.

## Import format

Paste tab-separated rows from the ordering app export (header row optional — columns are matched by name). Handles the `SKU (qty); …` items blob, pipe-delimited tx hashes / explorer URLs / PayPal receipts, and flags unknown SKUs before anything is written.

## Dev

```bash
cd src
bun install
bun run lint
bun x tsc --noEmit
```
