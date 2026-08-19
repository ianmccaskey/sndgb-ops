import { action } from '@uibakery/data';

function listReceiveAddresses() {
  return action('listReceiveAddresses', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, label, name, street1, street2, city, state, zip, country, phone, email, active
      FROM receive_addresses
      ORDER BY active DESC, label
    `,
  });
}

export default listReceiveAddresses;
