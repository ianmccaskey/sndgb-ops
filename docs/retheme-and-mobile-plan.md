# Retheme + mobile remediation plan (C★ "Ops console")

Approved design: the canvas at claude.ai/code/artifact/512bb25e-f246-4b4e-9ec2-1393e84059f2
(Final design page). Recipe: flat dark ground (#070b16), cyan→violet gradient
reserved for page identity + one primary action per page, JetBrains Mono for
numerals/tracking, pulsing amber LEDs ONLY on attention states, one 7s scanline
flare per page, no haze. Combined with the 2026-09-04 mobile audit findings so
the app is rethemed and made phone-worthy in one coherent pass.

## Phase 0 — foundations (one commit, app-wide)

1. **Tokens** (`src/index.css`): dark becomes THE theme — replace `:root` values
   with the C★ palette (background #070b16, card #0e1627, borders
   rgba(148,163,184,.16), primary #22d3ee on dark fg, muted slate ramp). Add
   Google Fonts `@import` (Inter + JetBrains Mono) and point `--font-sans` /
   `--font-mono` / `--layout-text-font-family` at them. Add keyframes
   (`led-pulse` 2.4s, `sweep` 7s, `banner-breathe` 3.2s) + utility classes
   (`.animate-led`, `.scanline`, `.text-gradient`, `.btn-gradient`). Remove the
   dead Tailwind-v4 `@theme` block (index.css:101–159).
2. **Shell** (`src/app/layout/AppLayout.tsx`): `h-screen` → `h-dvh` (fixes the
   hidden bottom strip on mobile browsers — audit #1). Add the **bottom tab
   bar** on `<md`: Home / Orders / Fulfill / Receive / More (More opens the
   sidebar sheet); active tab cyan with top indicator; 44px+ targets. Single
   global scanline element in the header. Sidebar/desktop unchanged.
3. **Dialog base** (`src/components/ui/dialog.tsx`): add
   `max-h-[85dvh] overflow-y-auto` to `DialogContent` so no dialog can strand
   its buttons off-screen (audit #2 — scan-receive modal, vendor-shipped
   dialog). ShippingModal's own `max-h-[90vh]` stays.
4. **Touch floor** (`src/index.css`):
   `@media (pointer: coarse) { button, [role="button"], input:not([type=checkbox]):not([type=radio]), select, [data-radix-select-trigger] { min-height: 2.75rem } }`
   — 44px on touch devices only; desktop density untouched. Spot-fix layouts
   this visibly breaks rather than pre-auditing all 167.
5. **Tables** (`src/components/ui/table.tsx`): base `<table>` gains
   `min-w-[560px]` so `overflow-x-auto` wrappers actually scroll instead of
   crushing (audit #4). Wider overrides where needed: ProductsPage campaign
   table `min-w-[1100px]`, VendorsPage payment log `min-w-[900px]`.
6. **iOS zoom-on-focus**: sweep the 33 `Input`/`SelectTrigger` usages overriding
   to `text-xs`/`text-[11px]` → drop the override (base is `text-base md:text-sm`,
   which is correct). Files: OrderDetailSheet (20), DashboardTab (7+9 selects),
   ShippingModal (3), TransfersTab, FulfillmentPage, ProductsPage.
7. **Destructive micro-targets** get size + confirmation:
   - OrderDetailSheet credit/refund delete ✕ (h-4 → h-8 w-8 + `window.confirm`)
   - photo-delete ✕ overlapping thumbnails (ShippingModal ×3, OrderDetailSheet;
     → h-8 w-8, offset clear of the thumb, confirm already exists via fn? add
     confirm)
   - DashboardTab chip-remove ✕ (:969 — no size class; → explicit h-6 w-6 min,
     44px under coarse pointer via #4)
   - PlannerPage "Mark ordered"/✕ pair (:663–667): add gap + confirm on ✕.
8. **Load-bearing hover tooltips → visible/tappable** (only the 8 identified):
   contains/only filter toggle (visible one-line caption), Part out button
   (caption under card row), ProductsPage digital flip (confirm dialog carrying
   the explanation) + weight edit (pencil icon), ShippingModal box/polymailer
   caveat + insured-value formula (small always-visible caption), refund-status
   titles on TransfersTab/VendorsPage (move to visible text), HomePage tile
   sub-label (drop truncate-with-title; wrap instead).

## Phase 1 — restyle sweep (same release)

Mechanical class translation across `src/app/pages/**` using a mapping table
(light tint → dark tint). Core mappings:

| Light (today) | Dark (C★) |
|---|---|
| `bg-amber-100 text-amber-900` | `bg-amber-400/10 text-amber-300` |
| `bg-green-100 text-green-800` | `bg-emerald-400/10 text-emerald-300` |
| `bg-blue-100 text-blue-800` | `bg-blue-400/10 text-blue-300` |
| `bg-violet-100 text-violet-800` | `bg-violet-400/10 text-violet-300` |
| `bg-red-100 text-red-800` | `bg-rose-400/10 text-rose-300` |
| `border-amber-300 bg-amber-50 text-amber-900` (warning boxes) | `border-amber-400/40 bg-amber-400/5 text-amber-200` |
| `text-muted-foreground` etc. | unchanged (token-driven) |

- `productChipClass` (receiving/shared.ts) and `TRACK_STYLES`/`StatusPill`
  get dark-tint palettes in one place — most chips follow automatically.
- Add `font-mono` to tracking numbers, money, counts (many already have it).
- LEDs: shared `<Led />` span (`.animate-led`) added to: OFD heads-up banner,
  `not pushed` badges (Fulfillment + ShippingModal), `needs attention` /
  pickup-waiting states, HomePage unshipped tile. Nothing else animates.
- Gradient: page `<h1>` titles get `.text-gradient`; exactly ONE
  `.btn-gradient` per page (Log package / Shipment session / Import).

## Phase 2 — Receiving Overview surface (second release)

The original goal, built from the canvas Final boards:
- New default **Overview tab** on Receiving: one card per location group with
  the three zones (Inbound / Here now / Recently out · 14d), dual truth counts
  (16px mono units + box glyphs incl. violet "N of M · parted" via the shared
  `boxConsumption()`), quiet groups collapsing to one-line rows, amystery-style
  attention card. Data: existing `listInboundPackages`, `listAddressInventory`,
  `listTransfers` — no schema changes.
- Phone: bottom-nav "Receive" lands here; full-width 44px Receive buttons;
  Scan as the labeled gradient primary in the header (mock: FinalPhoneReceiving).
- Fulfillment phone polish per FinalPhoneFulfillment mock: search field on the
  card view (the `md:hidden` card list already exists), action cards lead.

## Verification

- `bun x tsc --noEmit` + lint clean after each phase.
- Browser pane at 390×844 (`resize_window` mobile preset): walk Receiving
  (scan modal open + keyboard heights), Fulfillment cards, OrderDetailSheet,
  ShippingModal end-to-end; confirm no dialog buries its submit, tables scroll
  horizontally instead of crushing, bottom nav reachable, LEDs pulse only on
  attention states.
- Desktop spot-check 1280px: density preserved, one gradient per page.
- Ian pulls + releases after Phase 0+1, tests on his and Paige's actual phones
  before Phase 2 merges.
