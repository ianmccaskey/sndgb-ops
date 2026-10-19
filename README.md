# SND Group Buy Ops

UI Bakery Vibe app for running mixed-vendor group buys — the database-backed replacement for the GB4 Google Sheet. Two-admin internal tool (Ian + Paige); order intake stays in the external ordering app and is pasted into the Import page.

## Stack

- **UI Bakery Vibe project** (React 19 + Tailwind + Radix, `@uibakery/data` SQL actions) — pulled into UI Bakery from this repo, same workflow as `prtmgmt`.
- **Neon Postgres** — project `snd-gb-ops` (`flat-dream-33800739`), database `neondb`. Connect it in UI Bakery as datasource **`SND GB DB`** (the name is referenced by every action).
- **Moralis** (ETH + BASE) and **Helius** (SOL) for on-chain payment verification and wallet snapshots — keys are entered on the Settings page (stored in `app_settings`).
- **Anthropic API** (Claude) for the read-only **"Ask about this"** assistant on the order sheet, the Import page and the ship dialog: it explains recon states, red import rows and an order's audited history, and drafts notes and tracking emails the operator still submits. Reached through the org-level HTTP datasource **`Anthropic API`**, whose stored header holds the key (`src/actions/assistant/DATASOURCE.md` — create it before pulling, a missing datasource breaks sync). It has no write tool; member fields are never sent and free text is scrubbed of emails, phones and handles before it leaves; every question is audited (`assistant_asked`).

## Pages

| Page | What it replaces in the sheet |
|---|---|
| Dashboard | MOQ tracker totals + "where are we" glances |
| Orders | Orders tab (with per-order recon status inline); **Add order** creates a manual order that exists only in this app (base44-linked or unlinked campaigns only) |
| Import | Manual copy-paste into the Orders tab — now parsed, validated, idempotent |
| Reconciliation | Both audit tabs — per-order and per-rail, plus on-chain Verify buttons |
| Vendors | Vendor payment tracking (OVERPAID is loud, vendors are dropdowns) |
| Products | Products/MOQ tab + Profit tab inputs + the opaque "Adjustments" column |
| Fulfillment | (new) pack/ship queue, tracking, reship costs |
| Financials | Profit tab summary + wallet balances + supplies (now actually in P&L) |
| Settings | Fees, tolerance, API keys, wallet addresses, profit split |
| Campaign Setup | (new) publishes a campaign on p2collective.app: order-number code, payment options, published flag, import stats |
| COA Reports | (new) lab reports per campaign line for the storefront COA library (link, lab, batch, purity) |
| Polls | (new) member polls on the storefront: draft → open → closed, options, results, voter comments |

## Database

Schema lives in `src/migrations/` (already applied to Neon; tracked in `claude_migrations_applied`). All derived numbers are **views** (`v_moq_progress`, `v_product_profit`, `v_vendor_balances`, `v_order_reconciliation`, `v_rail_reconciliation`, `v_group_buy_pnl`) — nothing computed is ever stored, so nothing can go stale.

Key invariants:
- One quantity basis: `final_count = customer demand + audited admin adjustments`.
- Orders upsert on `order_number`; re-importing an export refreshes rather than duplicates.
- Payment overrides require a reason and are written to `audit_log`.
- Zip codes are text (leading zeros survive); states normalize to 2-letter codes at import.
- Ordering-app product ids are linked **per campaign** (`campaign_product_links`, `1790101900`): base44 keeps a separate Product record per group buy, so Mixed Buy #5's R30 and Elora & More's R30 are different ids. Imports, the product sync, the shipment push, the order-sheet push and the fulfillment check all resolve the link through the order's own campaign. `products.external_id` is a frozen legacy column — never read or write it.

### Manual orders (source `manual`)

An order that exists only in this app — never in base44 or on the storefront — is created from the Orders page (**Add order** → `createManualOrder`). The header carries `external_id NULL`, `raw_import = {source:'manual', created_by, created_at, request_id}` (the dialog's per-submit token: a create whose reply was lost is recovered by the request that made it and only that one — the same number under another token is another admin's order and a refused number), every money column 0 and `placed_at = now()`; the lines go in as **local items** (`addLocalOrderItem`, one call per line, whole kits at campaign price), so `v_order_reconciliation` bills the order at exactly its local items value, and demand/packing count the lines like any other order. Fees come from the order sheet (`setOrderFees`), payments from the existing payment flows. Rules:
- **Number shape is one no upstream can mint**: `<campaign prefix>-X<NNN>` (`2026-MB5-X001`, `2026-X001`), where the prefix is derived from the campaign's own upstream numbers (everything before the last hyphen of its most common shape; a campaign with no upstream orders yet uses the current year). Every base44 and storefront number ends in a digits-only segment, so a manual number can never be claimed by a later pull or paste. `nextManualOrderNumber` suggests the next free one (counted over the registry, both writers); `createManualOrder` re-derives the prefix and refuses any other shape, a registered number, a missing customer name, or a storefront campaign (one platform per campaign, `1790101100`) — the result row says which (`refused`), and the dialog shows it. The registry trigger registers the number as `ops` like any other.
- **Invisible to every upstream control**: `importUpsertOrder` never updates a `manual` row (a pasted row carrying its number is a refused collision), `syncOrderStatus` never cancels one, the deleted-upstream diff (`listActiveExternalOrders` / `cancelDeletedUpstream`) and the push/rail controls gate on `external_id` and `source = 'base44'`. Pulls never prune local items, so a base44 pull leaves a manual order untouched.
- **A manual order fixes the campaign's platform**: the one-platform trigger refuses storefront setup for a campaign holding orders from another source, so a campaign with a manual order can never move to the storefront. A storefront campaign shows no Add order button.
- Audited `manual_order_created`; the order sheet labels the order "Manual order" with who added it.

### Storefront source (p2collective.app)

The P² Collective storefront owns schema `storefront` in this database and is imported like any other upstream (Import → "Refresh from storefront"; a campaign is published from the **Campaign Setup** page, nav route `/storefront`): `listStorefrontOrders` → `mapStorefrontOrder` → the same `importUpsertOrder` / items / `importPayments` / cancellation actions base44 orders use. Settled rules, so reviewers don't re-open them:
- **A campaign runs on ONE ordering platform** (`1790101100` constraint triggers for every future write; `1790101200` refuses to apply while any existing campaign is on both): a storefront settings row is refused for a campaign linked to the base44 ordering app (`group_buys.external_id`) or holding orders from another source; linking a storefront campaign to base44 is refused (`linkGroupBuyExternal` returns no rows); a non-storefront order is refused in a storefront campaign (an import of one is a red row). Campaign Setup says so on the page. Publishing is its own action (`setStorefrontCampaignPublished`, the only writer of `published`); the setup save (`upsertStorefrontCampaign`) never touches that flag and is version-checked against the `updated_at` the page loaded, so a stale tab is refused instead of overwriting newer settings. Otherwise setting one up would flip its Import page to the storefront pull and hide the base44 pull for a campaign still being fulfilled. The storefront is for new campaigns: create the buy under Settings → New campaign, select it in the header switcher, then set it up.
- Storefront orders carry **no external id**; every base44-only control (push changes, rail push, deleted-upstream diff) stays hidden by the existing `external_id` gates.
- Storefront **payment claims** import on the rail they were made on (`ParsedPayment.method`), never the order header's. Claims in `pending`, `verified` and `mismatch` import — `mismatch` is a confirmed transfer to our wallet of a different amount, i.e. real money reconciliation must see; only `rejected` (failed on-chain, paid another wallet, never found) is not a payment and never imports. This app verifies every imported hash itself; the storefront's verdict is advisory. A claim the storefront rejects AFTER this app imported it pending — a tx hash or a cash receipt reference — is rejected here too on the next pull (`syncStorefrontRejectedClaims`, run for every pulled row — live, cancelled, or skipped by validation — BEFORE any payment imports; a release that fails aborts the whole run), never a row this app has verified itself.
- A **cancelled** storefront order can still hold a hash here that a live order now claims (its claim imported while it was live; this app keeps a hash on ONE order). On the next pull a *pending* local copy is released to the live claimant (`releaseCancelledStorefrontClaims`, audited `payment_released_cancelled_order`); a *verified* or *mismatch* copy is money this app saw land and is never moved by a pull — the live order’s import row turns red until an operator rejects or reassigns that payment by hand. The storefront itself refuses to cancel an order with a live claim, so this is the backstop for admin-side cancellations.
- **A hash that did not attach is never a green row.** `importPayments` reports every skipped hash with its holder; only "already on this same order, not rejected" is an idempotent re-import. A hash held by another order (live or cancelled) or rejected on this order leaves the order short, and its import row turns red naming the holder, so the operator rejects the wrong claim and pulls again. Duplicate claims are indexed across EVERY pulled row — live, cancelled, or skipped by validation — so an importable order that attaches a hash another row also claims gets its conflict note on the same pull, not after the other row is fixed.
- **A storefront order reconciles on the rail its money sits on.** `orders.payment_rail` is the key of `v_rail_reconciliation` and the rail cards, so the mapper sets it from the order’s live claims (verified/mismatch first, else pending): one rail → that rail (the header rail the member picked at checkout is kept in `raw_import.header_rail`, and the import row says "rail eth → base"); several rails → the header stays and the import row turns red (`rail_conflict`), because one order cannot be allocated to two wallets. `updateOrderRail` is for ordering-app orders; a storefront order follows its claims on every pull.
- **Every storefront order carries a client token** (`1790101000`: `storefront.orders.client_token` NOT NULL, unique per member). The order form mints one per load and a retried submission finds its order instead of minting another; no placement or repair path may insert without one.
- Cross-campaign invariants are database-enforced: an order pays only on an option of its own campaign on its own rail (`1790100100`), and carries only lines of its own campaign (`1790100200`).
- **Order numbers are unique across both writers** (`1790100300`): `public.order_number_registry` (primary key) is filled by `AFTER INSERT` triggers on `public.orders` and `storefront.orders`. A number the other side already holds fails the insert (`order_number_registry_pkey`) — for an import that is a red result row, never an overwrite. The one legitimate "shared" number is this app's imported copy of a storefront order (`raw_import.source = 'storefront'`), which reuses the storefront's claim instead of making a second one (`1790100500`) — and only after the trigger has found the storefront order with that number, campaign and id (`1790100600`); a "storefront copy" with no such row fails (`orders_storefront_copy_fk`). Order numbers are immutable on both tables (`1790100700`): a number is registered once, so a repair that needs a different number is a new order. `upsertStorefrontCampaign` also seeds a campaign's storefront sequence above every number this app holds, so the trigger is the backstop, not the normal path.
- "Paid" on the storefront is this app's reconciliation (`v_order_reconciliation.recon_status` matched/over); the storefront never marks an order paid from a shared-wallet hash on its own.
- **Tenant boundary is the storefront's server, not row-level security.** Only the storefront's Node server (and its worker) connects to this database, with a privileged role; browsers never hold a connection, the Neon Data API is not enabled, and no client-side SQL exists. Every member-facing query scopes by the Neon Auth session's `auth_user_id` in server code (`lib/customers`, `lib/orders`, `lib/payments`). RLS would not bind to anything in this topology (a privileged role bypasses it); it becomes the right tool if a less-privileged app role or the Data API is ever introduced, and that is the point to add it — not before.
- **Seller branding for the store hall** (`1790101600`, applied 2026-10-14): `storefront.sellers` gains `tagline`, `accent` (gold family CHECK), `emblem_media_id`, `mascot_media_id`, `sort_order`; `media_kind` gains `emblem` and `mascot`. The storefront writes them only through `storefront.set_seller_branding` / `attach_seller_media` / `clear_seller_media` (SECURITY DEFINER, approved individual sellers only, keys under `sellers/<id>/<slot>/`), so the least-privilege role in `1790101500` needs no new grants and its `REVOKE UPDATE ON storefront.sellers` cannot break uploads. `attach_seller_media` enforces the media contract itself (`1790101800`: logo PNG/WebP up to 1 MB, character PNG/WebP/GIF/WebM/MP4/MOV up to 4 MB, key `sellers/<id>/<slot>/<uuid>.<ext>` matching the type, no SVG). The functions are closed to PUBLIC (`1790101700`); only the owner and `p2_storefront` may execute them. `sort_order` (banner order) and the house's tagline and logo are set by the organizers by hand.

## Import format

Paste tab-separated rows from the ordering app export (header row optional — columns are matched by name). Handles the `SKU (qty); …` items blob, pipe-delimited tx hashes / explorer URLs / PayPal receipts, and flags unknown SKUs before anything is written.

## Dev

```bash
cd src
bun install
bun run lint
bun x tsc --noEmit
```
