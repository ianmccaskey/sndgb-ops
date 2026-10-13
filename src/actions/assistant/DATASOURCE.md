# Required workspace config: the "Anthropic API" HTTP datasource

The action in this folder executes on UI Bakery's backend through an
org-level HTTP datasource that CANNOT be versioned in this repo — it
lives in the UI Bakery workspace and must exist in every workspace that
runs this app. A missing datasource breaks the project's sync (the
Resend lesson, `docs/shipment-emails.md`), so create it BEFORE pulling a
build that contains `anthropicMessages.ts`.

Exact contract:

- **Type:** HTTP API
- **Name:** `Anthropic API` (exact — the action binds by this name)
- **Base URL:** `https://api.anthropic.com` (no trailing path)
- **Headers (stored on the datasource):** `x-api-key: <Anthropic API key>`.
  Nothing else. The key lives ONLY here: it is never an action param,
  never in `app_settings`, never in the browser. The action adds the
  protocol headers (`anthropic-version`, `anthropic-beta`,
  `Content-Type`) itself; do not duplicate them on the datasource.
- **Auth / Query params:** none.

To recreate: workspace sidebar → Data Sources → Connect → HTTP API →
fill the fields above → Connect Datasource → connect it to this app.

To verify after any change (or in a new environment): Settings page →
Assistant card → **Test assistant connection**. It sends one tiny
request through the full chain and names exactly what is wrong when it
fails (datasource missing, base URL wrong, key rejected).

## What travels, and the privacy decision

- Requests carry order numbers, amounts, statuses, tx hashes, item SKUs,
  operator-written notes and reasons, and the audited history of an
  order. Member fields never travel: the fact builders hand-pick columns,
  `readAuditTrail` strips raw upstream snapshots and shipment
  destinations, and `redact()` in `src/lib/assistant.ts` runs over the
  facts and every tool result — dropping any key that names a member
  field (including raw-paste headers like "discord username") and
  scrubbing emails, phone numbers and @handles out of every string.
  What CAN still travel is operator-written prose: a member's name typed
  into an admin note or a reason goes with the note, because the trail
  is the point. The tracking-email draft sends the customer's first name
  and nothing else about them.
- Anthropic does not train on API traffic; the default retention for
  API requests is 30 days. This was accepted when the assistant was
  built (2026-10-13) — a known decision, not an accident.
- Every question is logged to `audit_log` (`assistant_asked`, under the
  operator) with the question (scrubbed the same way, first 300
  characters), model and token usage — never the answer.

## The one rule

The assistant is READ-ONLY. Its tools are load actions; no write action
is ever exposed to the model, and a draft it produces is text the
operator pastes or a field the operator still submits. Do not add a
write tool — the safety gates in this app (confirm-cancel, reject-by-
hand, reason fields, over-buy confirmation) are the product, not toil.
