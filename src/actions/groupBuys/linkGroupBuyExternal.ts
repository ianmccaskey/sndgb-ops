import { action } from '@uibakery/data';

function linkGroupBuyExternal() {
  return action('linkGroupBuyExternal', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      UPDATE group_buys SET
        external_id = NULLIF({{params.external_id}}::text, '')
      WHERE id = {{params.id}}::bigint
      RETURNING id, external_id
    `,
  });
}

export default linkGroupBuyExternal;
