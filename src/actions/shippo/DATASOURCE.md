# Required workspace config: the "Shippo API" HTTP datasource

The two actions in this folder execute on UI Bakery's backend through an
org-level HTTP datasource that CANNOT be versioned in this repo — it
lives in the UI Bakery workspace and must exist in every workspace that
runs this app.

Exact contract (any drift breaks all tracking/rates/labels/refunds):

- **Type:** HTTP API
- **Name:** `Shippo API` (exact — the actions bind by this name)
- **Base URL:** `https://api.goshippo.com` (no trailing path)
- **Headers / Query params / Auth:** none required. The Authorization
  header travels per-request from the app (`ShippoToken <key>` with the
  key from Settings → Shippo). Optionally the operator may instead store
  `Authorization: ShippoToken <key>` here and blank the Settings key —
  that keeps the key fully server-side.

To recreate: workspace sidebar → Data Sources → Connect → HTTP API →
fill the fields above → Connect Datasource.

To verify after any change (or in a new environment): Settings page →
Shippo card → **Test Shippo connection**. It performs one cheap read
through the full chain and reports exactly what is wrong when it fails.

History: created 2026-08-24 when Shippo removed browser CORS support
(their preflight stopped returning Access-Control-Allow-Headers),
which killed the original browser-direct client.
