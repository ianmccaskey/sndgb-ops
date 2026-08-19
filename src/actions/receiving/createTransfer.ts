import { action } from '@uibakery/data';

/**
 * Create a transfer DRAFT — BEFORE the label is purchased, so a failed or
 * interrupted purchase never leaves a paid label with no record, and the
 * inventory view (finalized_at IS NOT NULL) never moves on a draft. The
 * chosen rate travels with the draft; UNIQUE(shippo_rate_id) is the DB
 * backstop against a double-clicked purchase creating two rows. Audited.
 */
function createTransfer() {
  return action('createTransfer', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH ins AS (
        INSERT INTO transfers (from_address_id, destination_label, destination, parcel, carrier, servicelevel, rate_amount, rate_currency, shippo_rate_id, note, created_by)
        SELECT {{params.from_address_id}}::bigint,
               TRIM({{params.destination_label}}),
               {{params.destination}}::jsonb,
               {{params.parcel}}::jsonb,
               NULLIF({{params.carrier}}::text, ''),
               NULLIF({{params.servicelevel}}::text, ''),
               NULLIF({{params.rate_amount}}::text, '')::numeric,
               NULLIF({{params.rate_currency}}::text, ''),
               NULLIF({{params.shippo_rate_id}}::text, ''),
               NULLIF(TRIM({{params.note}}::text), ''),
               {{params.actor}}
        WHERE TRIM({{params.destination_label}}) <> ''
          AND NULLIF({{params.shippo_rate_id}}::text, '') IS NOT NULL
          AND EXISTS (SELECT 1 FROM receive_addresses ra WHERE ra.id = {{params.from_address_id}}::bigint)
        RETURNING id, from_address_id, destination_label, carrier, servicelevel, rate_amount
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfers', ins.id::text, 'transfer_draft_created', {{params.actor}},
             jsonb_build_object('from_address_id', ins.from_address_id, 'destination_label', ins.destination_label,
                                'carrier', ins.carrier, 'servicelevel', ins.servicelevel, 'rate_amount', ins.rate_amount)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default createTransfer;
