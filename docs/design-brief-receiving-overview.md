# Design brief: Receiving per-address overview

> Paste this whole document into Claude Design (or any design session). It is
> self-contained: persona, product context, data, constraints, and asks.

## Your role

You are a ruthless, detail-obsessed product designer. You've studied every
pixel of Linear, Superhuman, Vercel, Raycast, and Arc. You can spot a
vibe-coded AI project from 50 feet away, and you refuse to ship one. Your
only goal here — the metric you are optimizing with every pixel — is
**glanceability**: an operator standing in a garage with a phone in one hand
must answer "what's coming here / what's here now / what just left" for any
address in **under two seconds**, without tapping anything. No decoration
that doesn't earn that. No summary number that hides a truth someone will
trip over.

## Product context

This is an internal logistics tool for a two-person group-buy operation
(Ian and Paige — the only users; there are no visitors, signups, or trials).
Product arrives from vendors in boxes at ~6 **receive addresses**, gets
received, sometimes gets **parted out** (a box opened and a portion shipped
onward), and leaves via **transfers** (to other addresses, or direct to
customers). Addresses form **location groups**: member addresses pool their
stock at a "transfer origin" (e.g. "Ian Home" receives boxes, but shipments
go out under the "Ian PMB 1" group).

Today the three facts live in three separate tabs (packages / inventory /
transfers), and that split caused a real incident: an address *looked* like
it held 6 boxes of a product when 3 had already shipped out. The design's
job is to put all three streams on one card per address group so that
mistake is impossible.

## The data available (all real, all already queryable)

Per address group, three streams. Backend queries can be reshaped freely —
do not constrain the design to current query shapes.

**INBOUND — un-received packages headed here**
- carrier + tracking number (mono font, can be 12–22 chars)
- tracking status: not checked · PRE_TRANSIT · TRANSIT · OUT FOR DELIVERY
  (today — this is the highest-urgency signal in the app) · DELIVERED ·
  RETURNED/FAILURE (attention states)
- ETA date, vendor code (e.g. UTHER, HXTNT), contents as product chips
  (e.g. `R30 × 30`, `Tesa 10 × 20`), note ("Incoming transfer from Ian PMB 1")

**CURRENT — what's physically here now**
- on-hand units per product (e.g. `R30 · 90 units`)
- physical boxes with remaining contents: a full box (`R30 × 30`) vs a
  parted box (`R30 × 12 of 30 · parted`). Boxes fully emptied by shipments
  are NOT here (they live in a History tab). **Both truths matter**: units
  for planning, boxes for "can I grab a sealed box." Never show only one.

**OUTBOUND — what recently left this group**
- finalized transfers: destination (another address, or "Direct: customer
  #order-number"), carrier + tracking, contents chips, date, label cost
- recent window only (last ~14 days); deep history lives elsewhere

Real example to design with (this is live data): group "Ian PMB 1" —
inbound: nothing; current: `R30 · 3 boxes · 90 units` (was 6 boxes, 3
shipped out), `T60 · 126 units`; outbound: 3 direct-to-customer boxes of
R30 × 30 (Aug 31) and `T60 × 41` to a customer (Sep 2, UPS, $10.43).
Another group, "Paige PMB 1": inbound 2 UPS boxes from Ian (Tesa 10 × 20
each, TRANSIT), current: mixed, outbound: quiet.

## Hard constraints — the design MUST be buildable in this stack

- React + TypeScript + **Tailwind** single-page app. **Light theme only.**
  No custom fonts (system stack), no images or illustrations, no CSS outside
  Tailwind utility classes.
- Component vocabulary is this exact shadcn/ui set, nothing else: Card,
  Table, Tabs, Badge, Button, Input, Select, Dialog, Sheet, Popover,
  Command, Tooltip, Separator, Skeleton, ScrollArea, Switch, Textarea,
  DropdownMenu, Avatar, Sidebar. Icons: lucide. Charts (if any): recharts.
- Data loads on page open via SQL actions; **no live updates** — refresh is
  an explicit action. Nothing in the design may assume real-time push.
- Keep the app's existing color language: per-product colored SKU chips
  (each product has a stable pastel); **amber** = needs attention /
  out-for-delivery; **green** = received/on hand; **violet** = parted /
  provenance; red = failure states.
- These existing actions must stay reachable from the overview (buttons or
  menus, not buried): Log inbound package, Mark received, Scan label,
  Part out / Transfer, Refresh tracking, Print box label.
- Mobile is first-class: cards collapse to one column; any table must have
  a card-style phone alternative or horizontal scroll. Tap targets ≥ 40px.

## Design asks — produce these artboards

1. **Desktop overview** (~1280px): all address groups visible, one card per
   group with the three zones (INBOUND / HERE NOW / RECENTLY OUT). Show how
   a busy group, a quiet group, and an attention state (out-for-delivery,
   RETURNED) look side by side. Where does a global "out for delivery
   today" heads-up live?
2. **Card anatomy** (annotated, one card blown up): exact hierarchy —
   group name, member addresses, the three zones, unit-vs-box dual counts,
   chip usage, where per-box actions hang.
3. **Phone layout** (~390px): the same overview one-handed. What
   collapses, what stays, how zones stack, where the primary actions sit.

Empty states matter: a group with nothing inbound and nothing recent
should compress to one quiet line, not an empty three-zone skeleton.
