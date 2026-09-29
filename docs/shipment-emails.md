# Shipment-notification emails (the app's own, via Resend)

## Why this exists

Shippo's dashboard "Enable email notification" toggle never fired for a
single one of our labels, despite every label carrying the customer's
email. Root cause (established 2026-09-29): Shippo sends notification
emails for **Orders** — objects created by their dashboard and store
integrations. Labels purchased through the raw API create only a
shipment + transaction, no Order; our Shippo Orders tab is empty, so
there has never been anything for their notifier to act on.

So the app sends its own "your order has shipped" email at label
finalize, through Resend. The email carries the order number, carrier +
service, the tracking number as a carrier-site link (same link logic as
the app's UI), and the box contents.

## One-time setup (operator)

1. **Resend account** — resend.com, free tier is far above our volume.
2. **Verify the sending domain** — resend.com/domains → Add domain →
   add the DNS records they show (SPF + DKIM) where the domain's DNS is
   hosted. Until this verifies, Resend only delivers to the account
   owner's own address (their 403 says exactly that) — fine for testing,
   useless for customers.
3. **API key** — resend.com → API Keys → Create ("Sending access" is
   enough). Starts with `re_`.
4. **UI Bakery datasource** — the workspace needs an HTTP datasource
   named exactly `Resend API` with base URL `https://api.resend.com`
   and nothing else configured. Full contract:
   [src/actions/resend/DATASOURCE.md](../src/actions/resend/DATASOURCE.md).
5. **Settings → Shipment emails** — paste the key, set the from-address
   (must use the verified domain, e.g. `SND GB <ship@yourdomain.com>`),
   optional reply-to, Save, then **Send test email** to yourself and
   check inbox + spam.

The feature is OFF until both the key and from-address are saved —
everything below silently no-ops while it's off.

## When an email goes out

| Event | Email? |
|---|---|
| Shippo label purchased in the Ship modal | yes, right after the finalize saves |
| Manual label recorded in the Ship modal | yes (these were never coverable by any carrier integration) |
| Draft recovery lands (retry save / recover by txn / check-Shippo-retry / delete-turned-recovery) | yes, same as the happy path |
| Direct-ship transfer finalized (label bought or manual) | yes — to the customer on the order line |
| Internal admin-to-admin transfer | never (no customer) |
| Shippo TEST-mode label | never (the tracking is simulated) |
| Order/destination has no email | never (the Ship modal says so up front) |
| Any refund activity on the label | never auto-sent (a human is unwinding it) |
| Reclaimed direct-ship draft's recovered label | never auto-sent (orphaned label — human decides) |
| Historical shipments from before this feature | never automatically — each finalized row shows a **Send email** button instead |

## Double-send safety

`tracking_email_sent_at` on the shipment/transfer row is a CAS claim:
only the session that flips it from NULL may send, so recovery paths
re-running a finalize can't email twice. On top of that, every send
carries a Resend `Idempotency-Key` derived from the row id (Resend
stores keys 24h and replays the first result).

Failures split by what is actually known:

- **Definitive refusal** (Resend's structured 4xx — bad key, unverified
  domain, invalid payload): nothing was sent, so the claim is released
  (CAS on the exact claim token), the error lands on the row (amber
  "email failed" chip), and the row offers **Retry email**.
- **Ambiguous failure** (timeout, 5xx, unrecognized response): the email
  *may have been delivered*, so the claim is **held** and the row shows
  an amber **"email unverified"** chip. Nothing retries automatically —
  a blind retry past the 24h idempotency window could email the
  customer twice. The row offers **Release & retry**, to be used only
  after resend.com/emails shows no send for that recipient (the confirm
  dialog says exactly that).

Accepted edge: if the browser dies between claim and send, the row reads
"emailed" with no email — rare, and fails in the safe direction (never a
duplicate to a customer).

## Where the state shows

- **Ship modal, ship-to card**: says up front whether a shipped email
  will go out for this box, and why not when it won't.
- **Ship modal, finalized rows**: `emailed` chip (hover = when + to
  whom), `email failed` chip + Retry, or a `Send email` button for
  never-sent rows (including pre-feature history — operator's choice,
  nothing is backfilled automatically).
- **Receiving → Transfers log**: same chips/button on direct-ship rows.

## Deliverability notes

- SPF/DKIM come from the domain verification records. If customers
  report spam-foldering, add the DMARC record Resend suggests on the
  domain page.
- resend.com/emails lists every send with its delivery status — the
  first place to look when a customer says "no email".
