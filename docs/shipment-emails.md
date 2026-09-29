# Shipment-notification emails (Shippo order-linked)

## Why this exists

Shippo's dashboard "Enable email notification" toggle never fired for a
single one of our labels, despite every label carrying the customer's
email. Root cause (established 2026-09-29, confirmed by Shippo support):
Shippo sends notification emails for **Orders** — labels must be tied to
a Shippo Order that gets fulfilled. Labels purchased through the raw API
create only a shipment + transaction, no Order; our Shippo Orders tab
was empty, so there was never anything for their notifier to act on.

## How the app closes the gap

Right before each label purchase the app creates a Shippo **Order**
carrying the customer's email, order number, and box contents, stores
its id on the draft (`shipments/transfers.shippo_order_id`), and passes
it in the transaction request. Shippo auto-flips the order to SHIPPED on
purchase, which arms their tracking notification emails (dashboard
Settings → Tracking → Emails, already ON with "Send immediately").

- **Covers**: every Shippo label bought in the app — order shipments and
  direct-ship transfers (internal admin transfers are deliberately
  unlinked; no customer, no email). Retry/recovery purchases reuse the
  draft's stored order id, so a retried label never creates a duplicate
  Shippo order. Order creation runs BEFORE the purchase-lease heartbeat
  so its latency can never widen the money window.
- **Does NOT cover**: manually recorded labels (bought outside the app),
  labels recovered from a transaction originally purchased unlinked, the
  389 pre-feature labels, and Shippo test-mode labels (never linked by
  design — simulated tracking must not email anyone).
- **Fail-soft**: if the order create fails, the label still purchases —
  unlinked — and the purchase outcome says "Shippo will NOT email
  tracking for this box — email the customer the tracking number
  yourself." Linked boxes show an emerald `shippo emails` chip on the
  shipment/transfer row (positive-only; absence is the norm for
  pre-feature rows). The Ship modal and the direct-ship panel state up
  front, per box, whether an email will go out and why not when it
  won't.
- **Content/branding**: Shippo's template from Shippo's sender. Custom
  branding is a paid Shippo plan feature.
- **Verifying a send**: Shippo dashboard → Orders shows the order as
  SHIPPED with its transaction; their Emails settings page governs which
  events send.

## History: the removed Resend fallback

An app-sent email channel (Resend, claim-then-send CAS on
`tracking_email_sent_at`, unverified-hold discipline) was built first
and then REMOVED on 2026-09-29 — Ian chose Shippo-only, and the unused
`resendPost` action broke UI Bakery's sync by requiring a datasource
that didn't exist. If app-sent emails are ever wanted again (e.g. for
manual labels), the full twice-reviewed implementation lives in git
history: commits 183284d and d459e5b (removal commit for the file list).
The `tracking_email_sent_at` / `tracking_email_error` columns from
migration 1789800000 remain in the database, unused and harmless.
