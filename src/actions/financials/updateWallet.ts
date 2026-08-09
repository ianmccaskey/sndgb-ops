import { action } from '@uibakery/data';

function updateWallet() {
  return action('updateWallet', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE wallets SET
        address = NULLIF({{params.address}}::text, ''),
        active = {{params.active}}::boolean
      WHERE id = {{params.id}}::bigint
      RETURNING id
    `,
  });
}

export default updateWallet;
