import { action } from '@uibakery/data';

function saveSetting() {
  return action('saveSetting', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      INSERT INTO app_settings (key, value)
      VALUES ({{params.key}}, {{params.value}})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `,
  });
}

export default saveSetting;
