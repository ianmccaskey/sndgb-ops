import { action } from '@uibakery/data';

function listVendors() {
  return action('listVendors', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `SELECT id, code, name, notes, active FROM vendors ORDER BY code`,
  });
}

export default listVendors;
