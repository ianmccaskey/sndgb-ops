import { action } from '@uibakery/data';

/** Saved transfer destination (address book), keyed on label. Audited. */
function saveDestination() {
  return action('saveDestination', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        INSERT INTO transfer_destinations (label, name, street1, street2, city, state, zip, country, phone, email, created_by)
        SELECT TRIM({{params.label}}::text), TRIM({{params.name}}::text), TRIM({{params.street1}}::text),
               NULLIF(TRIM({{params.street2}}::text), ''),
               TRIM({{params.city}}::text), TRIM({{params.state}}::text), TRIM({{params.zip}}::text),
               COALESCE(NULLIF(TRIM({{params.country}}::text), ''), 'US'),
               NULLIF(TRIM({{params.phone}}::text), ''), NULLIF(TRIM({{params.email}}::text), ''),
               {{params.actor}}::text
        WHERE TRIM({{params.label}}::text) <> '' AND TRIM({{params.name}}::text) <> '' AND TRIM({{params.street1}}::text) <> ''
          AND TRIM({{params.city}}::text) <> '' AND TRIM({{params.state}}::text) <> '' AND TRIM({{params.zip}}::text) <> ''
        ON CONFLICT (label) DO UPDATE SET
          name = EXCLUDED.name, street1 = EXCLUDED.street1, street2 = EXCLUDED.street2,
          city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
          country = EXCLUDED.country, phone = EXCLUDED.phone, email = EXCLUDED.email
        RETURNING id, label
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfer_destinations', up.id::text, 'destination_saved', {{params.actor}}::text,
             jsonb_build_object('label', up.label)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default saveDestination;
