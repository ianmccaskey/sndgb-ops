import { action } from '@uibakery/data';

/**
 * Delete one COA report of the selected campaign (the page confirms first).
 * One row, audited with the full removed row.
 *
 * Refused (zero rows) when the report belongs to another campaign, when it
 * changed since the page loaded it (`expected_version`, same digest as the
 * edit), or when a P² store listing cites it — store listings are managed
 * in the P2 Collective Orders app, and the foreign key would refuse anyway.
 * An uploaded PDF (media_id) is not removed with it.
 */
function deleteStorefrontCoaReport() {
  return action('deleteStorefrontCoaReport', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.id}}::text, '')::bigint AS id,
               NULLIF({{params.group_buy_id}}::text, '')::bigint AS group_buy_id,
               NULLIF({{params.expected_version}}::text, '') AS expected_version,
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin') AS actor
      ), del AS (
        DELETE FROM storefront.coa_reports c
        USING group_buy_products gbp, inp
        WHERE c.id = inp.id
          AND gbp.id = c.group_buy_product_id
          AND gbp.group_buy_id = inp.group_buy_id
          AND md5(row(c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
                      c.tested_at, c.purity_pct, c.notes)::text) = inp.expected_version
          AND NOT EXISTS (SELECT 1 FROM storefront.store_listings sl WHERE sl.coa_report_id = c.id)
        RETURNING c.id, c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
                  c.tested_at, c.purity_pct, c.notes, c.created_by, c.created_at
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data)
        SELECT 'storefront.coa_reports', del.id::text, 'coa_report_deleted', inp.actor,
               jsonb_build_object('group_buy_id', inp.group_buy_id, 'group_buy_product_id', del.group_buy_product_id,
                                  'lab', del.lab, 'report_url', del.report_url, 'media_id', del.media_id,
                                  'batch_label', del.batch_label, 'tested_at', del.tested_at,
                                  'purity_pct', del.purity_pct, 'notes', del.notes,
                                  'created_by', del.created_by, 'created_at', del.created_at)
        FROM del, inp
        RETURNING row_pk
      )
      SELECT id FROM del
    `,
  });
}

export default deleteStorefrontCoaReport;
