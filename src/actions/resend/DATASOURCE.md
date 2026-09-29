# Required workspace config: the "Resend API" HTTP datasource

The action in this folder executes on UI Bakery's backend through an
org-level HTTP datasource that CANNOT be versioned in this repo — it
lives in the UI Bakery workspace and must exist in every workspace that
runs this app, exactly like the "Shippo API" datasource.

Exact contract (any drift breaks shipment-notification emails):

- **Type:** HTTP API
- **Name:** `Resend API` (exact — the action binds by this name)
- **Base URL:** `https://api.resend.com` (no trailing path)
- **Headers / Query params / Auth:** none. The Authorization header
  travels per-request from the app (`Bearer <key>` with the key from
  Settings → Shipment emails) — a datasource-stored Authorization
  header would be shadowed/conflict and is NOT supported.

To recreate: workspace sidebar → Data Sources → Connect → HTTP API →
fill the fields above → Connect Datasource.

To verify after any change (or in a new environment): Settings page →
Shipment emails card → **Send test email**. One real send through the
full chain; the result message says exactly what is wrong when it fails.

Resend-side prerequisites (docs/shipment-emails.md has the full runbook):
- An API key from resend.com (API Keys page).
- A VERIFIED sending domain (resend.com/domains — add the DNS records
  they show). Until a domain is verified, Resend only delivers to the
  account owner's own email address (their 403 says so explicitly) —
  which is exactly what makes the pre-verification test send safe.

History: created 2026-09-29 when the Shippo tracking-email investigation
concluded Shippo does not send notification emails for API-purchased
labels (no Order objects → empty Orders tab → no notifications), so the
app took over the customer "shipped" email itself.
