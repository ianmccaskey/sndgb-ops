import { action } from '@uibakery/data';

function listReceiveAddresses() {
  return action('listReceiveAddresses', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, label, name, street1, street2, city, state, zip, country, phone, email, active, is_default_ship_from, transfer_origin_id
      FROM receive_addresses
      ORDER BY active DESC, label
    `,
  });
}

export default listReceiveAddresses;
