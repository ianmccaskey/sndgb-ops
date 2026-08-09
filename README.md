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

## Import format

Paste tab-separated rows from the ordering app export (header row optional — columns are matched by name). Handles the `SKU (qty); …` items blob, pipe-delimited tx hashes / explorer URLs / PayPal receipts, and flags unknown SKUs before anything is written.

## Dev

```bash
cd src
bun install
bun run lint
bun x tsc --noEmit
```
