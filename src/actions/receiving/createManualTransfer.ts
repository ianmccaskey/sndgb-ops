import { action } from '@uibakery/data';

/**
 * Record a transfer whose label was bought OUTSIDE the app — the
 * operator hand-enters carrier + tracking (+ optional cost). All the
 * real logic lives in the create_manual_transfer() DB function
 * (migration 1786472900): the SAME locks, content-CAS checks,
 * reservation math, and row-locked direct-line gates as
 * create_transfer_draft, but the row is born FINALIZED (no purchase
 * lifecycle — no money moves through the app) and a linked direct-ship
 * line is stamped ATOMICALLY in the same transaction (any gate failure
 * refuses the WHOLE record; refusing is free here because nothing was
 * charged). Returns (id); ZERO ROWS = refused.
 */
function createManualTransfer() {
  return action('createManualTransfer', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id FROM create_manual_transfer(
        {{params.from_address_id}}::bigint,
        {{params.destination_label}}::text,
        {{params.destination}}::jsonb,
        {{params.carrier}}::text,
        {{params.tracking_number}}::text,
        {{params.cost}}::text,
        {{params.items}}::jsonb,
        {{params.allow_over_onhand}}::boolean,
        {{params.expected_from}}::jsonb,
        NULLIF({{params.destination_id}}::text, '')::bigint,
        NULLIF({{params.expected_destination}}::text, '')::jsonb,
        {{params.note}}::text,
        {{params.actor}}::text,
        NULLIF({{params.direct_order_item_id}}::text, '')::bigint,
        NULLIF({{params.group_buy_id}}::text, '')::bigint,
        NULLIF({{params.source_package_id}}::text, '')::bigint
      )
    `,
  });
}

export default createManualTransfer;
