import { action } from '@uibakery/data';

/**
 * Edit one COA report of the selected campaign. One row, audited with the
 * before and after values.
 *
 * Version-checked: `expected_version` is the digest listStorefrontCoaReports
 * handed the page; a row another admin or tab changed since is refused (and
 * locked while checked, so two saves cannot both pass). The line it belongs
 * to never changes here, and neither does an uploaded PDF (media_id) — a
 * report that has one may drop its link; one without must keep an http(s)
 * link. Same input guards as addStorefrontCoaReport; zero rows = refused.
 */
function updateStorefrontCoaReport() {
  return action('updateStorefrontCoaReport', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.id}}::text, '')::bigint AS id,
               NULLIF({{params.group_buy_id}}::text, '')::bigint AS group_buy_id,
               NULLIF({{params.expected_version}}::text, '') AS expected_version,
               NULLIF(btrim({{params.lab}}::text), '') AS lab,
               NULLIF(btrim({{params.report_url}}::text), '') AS report_url,
               NULLIF(btrim({{params.batch_label}}::text), '') AS batch_label,
               NULLIF(btrim({{params.tested_at}}::text), '') AS tested_at_txt,
               NULLIF(btrim({{params.purity_pct}}::text), '') AS purity_txt,
               NULLIF(btrim({{params.notes}}::text), '') AS notes,
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin') AS actor
      ), val AS (
        SELECT inp.*,
               CASE WHEN inp.tested_at_txt ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN inp.tested_at_txt::date END AS tested_at,
               CASE WHEN inp.purity_txt ~ '^[0-9]{1,3}(\\.[0-9]{1,2})?$' THEN inp.purity_txt::numeric END AS purity_pct
        FROM inp
      ), old AS (
        -- the row as the page loaded it, in THIS campaign, locked for the update
        SELECT c.id, c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
               c.tested_at, c.purity_pct, c.notes
        FROM storefront.coa_reports c
        JOIN group_buy_products gbp ON gbp.id = c.group_buy_product_id
        JOIN val v ON v.id = c.id AND gbp.group_buy_id = v.group_buy_id
        WHERE md5(row(c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
                      c.tested_at, c.purity_pct, c.notes)::text) = v.expected_version
        FOR UPDATE OF c
      ), upd AS (
        UPDATE storefront.coa_reports c SET
          lab = v.lab,
          report_url = v.report_url,
          batch_label = v.batch_label,
          tested_at = v.tested_at,
          purity_pct = v.purity_pct,
          notes = v.notes
        FROM old o, val v
        WHERE c.id = o.id
          AND ((v.report_url ~* '^https?://[^/[:space:]]+([/?#][^[:space:]]*)?$' AND length(v.report_url) <= 2000)
               OR (v.report_url IS NULL AND o.media_id IS NOT NULL))
          AND (v.tested_at_txt IS NULL OR v.tested_at IS NOT NULL)
          AND (v.purity_txt IS NULL OR (v.purity_pct IS NOT NULL AND v.purity_pct <= 100))
        RETURNING c.id, c.group_buy_product_id, c.lab, c.report_url, c.batch_label, c.tested_at, c.purity_pct, c.notes
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'storefront.coa_reports', upd.id::text, 'coa_report_updated', v.actor,
               jsonb_build_object('lab', o.lab, 'report_url', o.report_url, 'batch_label', o.batch_label,
                                  'tested_at', o.tested_at, 'purity_pct', o.purity_pct, 'notes', o.notes),
               jsonb_build_object('group_buy_id', v.group_buy_id, 'group_buy_product_id', upd.group_buy_product_id,
                                  'lab', upd.lab, 'report_url', upd.report_url, 'batch_label', upd.batch_label,
                                  'tested_at', upd.tested_at, 'purity_pct', upd.purity_pct, 'notes', upd.notes)
        FROM upd
        JOIN old o ON o.id = upd.id
        CROSS JOIN val v
        RETURNING row_pk
      )
      SELECT id FROM upd
    `,
  });
}

export default updateStorefrontCoaReport;
