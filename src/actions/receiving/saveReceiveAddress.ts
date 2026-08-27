import { action } from '@uibakery/data';

/**
 * Create or update a reusable receive address, keyed on its label (the
 * short UI name). All Shippo-required fields enforced non-blank so a
 * saved address can always be used as a label ship-from. Updating an
 * ARCHIVED label refuses (zero rows): this upsert never reactivates,
 * so a "saved" on an archived label would look like success while the
 * label stayed unusable — restore it first (Addresses tab). Enforced
 * here, not just in previews, so a concurrent archive between preview
 * and import cannot slip through. Audited.
 */
function saveReceiveAddress() {
  return action('saveReceiveAddress', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        INSERT INTO receive_addresses (label, name, street1, street2, city, state, zip, country, phone, email, created_by)
        SELECT TRIM({{params.label}}::text), TRIM({{params.name}}::text), TRIM({{params.street1}}::text),
               NULLIF(TRIM({{params.street2}}::text), ''),
               TRIM({{params.city}}::text), TRIM({{params.state}}::text), TRIM({{params.zip}}::text),
               COALESCE(NULLIF(TRIM({{params.country}}::text), ''), 'US'),
               NULLIF(TRIM({{params.phone}}::text), ''), NULLIF(TRIM({{params.email}}::text), ''),
               {{params.actor}}
        WHERE TRIM({{params.label}}::text) <> '' AND TRIM({{params.name}}::text) <> '' AND TRIM({{params.street1}}::text) <> ''
          AND TRIM({{params.city}}::text) <> '' AND TRIM({{params.state}}::text) <> '' AND TRIM({{params.zip}}::text) <> ''
        ON CONFLICT (label) DO UPDATE SET
          name = EXCLUDED.name, street1 = EXCLUDED.street1, street2 = EXCLUDED.street2,
          city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
          country = EXCLUDED.country, phone = EXCLUDED.phone, email = EXCLUDED.email
        WHERE receive_addresses.active
          -- expected_id is the caller's reviewed intent: 'any' (manual
          -- form — the operator just typed this label, upsert-by-label
          -- is the semantic), '' (reviewed as a NEW label — a concurrent
          -- create must REFUSE, never be silently overwritten), or the
          -- id of the record reviewed as the update target (drift to a
          -- different record refuses). Enforced here so no client
          -- snapshot window can turn a reviewed create into an overwrite.
          AND ({{params.expected_id}}::text = 'any'
               OR receive_addresses.id = NULLIF({{params.expected_id}}::text, '')::bigint)
        RETURNING id, label
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'receive_addresses', up.id::text, 'receive_address_saved', {{params.actor}},
             jsonb_build_object('label', up.label)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default saveReceiveAddress;
