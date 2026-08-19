import { action } from '@uibakery/data';

function listDestinations() {
  return action('listDestinations', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      SELECT id, label, name, street1, street2, city, state, zip, country, phone, email, active
      FROM transfer_destinations
      ORDER BY active DESC, label
    `,
  });
}

export default listDestinations;
