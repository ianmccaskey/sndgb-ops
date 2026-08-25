import { action } from '@uibakery/data';

/**
 * Create a transfer DRAFT — BEFORE the label is purchased, so a failed or
 * interrupted purchase never leaves a paid label with no record. All the
 * real logic lives in the create_transfer_draft() DB function (migration
 * 1786471700): per-address advisory-lock SERIALIZATION of the
 * availability check (two concurrent creators cannot both pass the
 * over-check against the same stock), atomic draft+items insert,
 * active + content-matched ship-from (expected_from) and SAVED
 * destination (destination_id + expected_destination; custom = NULL
 * bypass), state-aware draft reservations, the explicit over-on-hand
 * override, the birth purchase lease, and the audit row. Optional
 * direct_order_item_id links ONE outstanding vendor-direct order line
 * (validated inside the fn: outstanding, money-gated, product-matched)
 * — finalizeTransfer stamps that line fulfilled when the label lands.
 * Returns (id, claimed_at); ZERO ROWS = refused.
 */
function createTransfer() {
  return action('createTransfer', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, claimed_at FROM create_transfer_draft(
        {{params.from_address_id}}::bigint,
        {{params.destination_label}},
        {{params.destination}}::jsonb,
        {{params.parcel}}::jsonb,
        {{params.carrier}}::text,
        {{params.servicelevel}}::text,
        {{params.rate_amount}}::text,
        {{params.rate_currency}}::text,
        {{params.shippo_rate_id}}::text,
        {{params.items}}::jsonb,
        {{params.allow_over_onhand}}::boolean,
        {{params.expected_from}}::jsonb,
        NULLIF({{params.destination_id}}::text, '')::bigint,
        NULLIF({{params.expected_destination}}::text, '')::jsonb,
        {{params.note}}::text,
        {{params.actor}},
        NULLIF({{params.direct_order_item_id}}::text, '')::bigint,
        NULLIF({{params.group_buy_id}}::text, '')::bigint
      )
    `,
  });
}

export default createTransfer;
