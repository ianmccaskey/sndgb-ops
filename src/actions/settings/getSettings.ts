import { action } from '@uibakery/data';

function getSettings() {
  return action('getSettings', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `SELECT key, value FROM app_settings ORDER BY key`,
  });
}

export default getSettings;
