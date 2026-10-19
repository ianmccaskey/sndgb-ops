import { action } from '@uibakery/data';

/**
 * The ordering-app product sync's link write: base44 Product external_id
 * stands for local product product_id in campaign group_buy_id (a campaign
 * linked to the ordering app). Links are per campaign (1790101900) — this
 * never touches another campaign's link, which is the whole point.
 *
 * outcome:
 *   linked          new link written
 *   unchanged       already linked exactly so
 *   relinked        the product's previous link in this campaign was
 *                   replaced — allowed ONLY when none of this campaign's
 *                   imported orders reference the old id (a base44 record
 *                   recreated before any order used it)
 *   ext_taken       that base44 product already stands for another
 *                   product here (ext_holder_sku names it)
 *   product_linked  the product is already linked here to a different
 *                   base44 product that this campaign's orders use
 *                   (current_external_id) — two records for one product
 *                   in one campaign is refused, never guessed
 *   conflict        another sync changed the links mid-request; pull again
 *   refused         bad input: no actor/id, unknown product, or a campaign
 *                   that is not linked to the ordering app
 * Audited per write. Not money; the unique constraints arbitrate
 * concurrent syncs, and the relink is a compare-and-set on the old id.
 */
function linkCampaignProduct() {
  return action('linkCampaignProduct', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.group_buy_id}}::text, '')::bigint AS gb,
               NULLIF({{params.product_id}}::text, '')::bigint AS pid,
               NULLIF(btrim({{params.external_id}}::text), '') AS ext,
               NULLIF(btrim({{params.actor}}::text), '') AS actor
      ), ok AS (
        SELECT inp.* FROM inp
        WHERE inp.actor IS NOT NULL AND inp.ext IS NOT NULL
          AND EXISTS (SELECT 1 FROM group_buys g WHERE g.id = inp.gb AND g.external_id IS NOT NULL)
          AND EXISTS (SELECT 1 FROM products p WHERE p.id = inp.pid)
      ), by_ext AS (
        SELECT l.id, l.product_id FROM campaign_product_links l, ok
        WHERE l.group_buy_id = ok.gb AND l.external_id = ok.ext
      ), by_prod AS (
        SELECT l.id, l.external_id FROM campaign_product_links l, ok
        WHERE l.group_buy_id = ok.gb AND l.product_id = ok.pid
      ), old_used AS (
        -- does any of this campaign's imported base44 orders reference the
        -- product's CURRENT link? Then that link is evidence, not a typo.
        SELECT EXISTS (
          SELECT 1
          FROM by_prod, ok, orders o
          CROSS JOIN LATERAL jsonb_array_elements(((o.raw_import->>'json')::jsonb)->'items') it
          WHERE o.group_buy_id = ok.gb
            AND o.raw_import->>'source' = 'base44'
            AND it->>'product_id' = by_prod.external_id
        ) AS used
      ), ins AS (
        INSERT INTO campaign_product_links (group_buy_id, product_id, external_id, linked_by)
        SELECT ok.gb, ok.pid, ok.ext, ok.actor FROM ok
        WHERE NOT EXISTS (SELECT 1 FROM by_ext) AND NOT EXISTS (SELECT 1 FROM by_prod)
        ON CONFLICT DO NOTHING
        RETURNING id, group_buy_id, product_id, external_id
      ), upd AS (
        UPDATE campaign_product_links l
           SET external_id = ok.ext, linked_by = ok.actor, linked_at = now()
          FROM ok, by_prod, old_used
         WHERE l.id = by_prod.id
           AND l.external_id = by_prod.external_id
           AND NOT EXISTS (SELECT 1 FROM by_ext)
           AND NOT old_used.used
        RETURNING l.id, l.group_buy_id, l.product_id, l.external_id, by_prod.external_id AS old_external_id
      ), aud AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'campaign_product_links', ins.id::text, 'campaign_product_linked', (SELECT actor FROM ok), NULL,
               jsonb_build_object('group_buy_id', ins.group_buy_id, 'product_id', ins.product_id, 'external_id', ins.external_id)
        FROM ins
        UNION ALL
        SELECT 'campaign_product_links', upd.id::text, 'campaign_product_relinked', (SELECT actor FROM ok),
               jsonb_build_object('external_id', upd.old_external_id),
               jsonb_build_object('group_buy_id', upd.group_buy_id, 'product_id', upd.product_id, 'external_id', upd.external_id)
        FROM upd
        RETURNING row_pk
      )
      SELECT CASE
               WHEN NOT EXISTS (SELECT 1 FROM ok) THEN 'refused'
               WHEN EXISTS (SELECT 1 FROM ins) THEN 'linked'
               WHEN EXISTS (SELECT 1 FROM upd) THEN 'relinked'
               WHEN (SELECT product_id FROM by_ext) = (SELECT pid FROM ok) THEN 'unchanged'
               WHEN EXISTS (SELECT 1 FROM by_ext) THEN 'ext_taken'
               WHEN EXISTS (SELECT 1 FROM by_prod) AND (SELECT used FROM old_used) THEN 'product_linked'
               ELSE 'conflict'
             END AS outcome,
             (SELECT p.sku_code FROM by_ext JOIN products p ON p.id = by_ext.product_id) AS ext_holder_sku,
             (SELECT external_id FROM by_prod) AS current_external_id
    `,
  });
}

export default linkCampaignProduct;
