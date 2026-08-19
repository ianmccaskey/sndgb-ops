import { action } from '@uibakery/data';

/** Saved transfer destination (address book), keyed on label. Audited. */
function saveDestination() {
  return action('saveDestination', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        INSERT INTO transfer_destinations (label, name, street1, street2, city, state, zip, country, phone, email, created_by)
        SELECT TRIM({{params.label}}), TRIM({{params.name}}), TRIM({{params.street1}}),
               NULLIF(TRIM({{params.street2}}::text), ''),
               TRIM({{params.city}}), TRIM({{params.state}}), TRIM({{params.zip}}),
               COALESCE(NULLIF(TRIM({{params.country}}::text), ''), 'US'),
               NULLIF(TRIM({{params.phone}}::text), ''), NULLIF(TRIM({{params.email}}::text), ''),
               {{params.actor}}
        WHERE TRIM({{params.label}}) <> '' AND TRIM({{params.name}}) <> '' AND TRIM({{params.street1}}) <> ''
          AND TRIM({{params.city}}) <> '' AND TRIM({{params.state}}) <> '' AND TRIM({{params.zip}}) <> ''
        ON CONFLICT (label) DO UPDATE SET
          name = EXCLUDED.name, street1 = EXCLUDED.street1, street2 = EXCLUDED.street2,
          city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
          country = EXCLUDED.country, phone = EXCLUDED.phone, email = EXCLUDED.email
        RETURNING id, label
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'transfer_destinations', up.id::text, 'destination_saved', {{params.actor}},
             jsonb_build_object('label', up.label)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default saveDestination;
