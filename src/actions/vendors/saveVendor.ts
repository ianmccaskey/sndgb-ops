import { action } from '@uibakery/data';

function saveVendor() {
  return action('saveVendor', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO vendors (code, name, notes, active)
      VALUES (
        UPPER(TRIM({{params.code}}::text)),
        {{params.name}},
        NULLIF({{params.notes}}::text, ''),
        {{params.active}}::boolean
      )
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        notes = EXCLUDED.notes,
        active = EXCLUDED.active
      RETURNING id
    `,
  });
}

export default saveVendor;
