import { action } from '@uibakery/data';

/**
 * Attach a lab report to one line of the selected campaign. One row, audited.
 *
 * The report is a link to the lab-hosted COA (http/https only); PDF uploads
 * (media_id) are not written here. Every report states the TESTED MASS and
 * the PURITY (Ian, 2026-11-09; the table's coa_reports_mass_and_purity CHECK,
 * 1790104000), and the endotoxin screening's outcome when the lab ran one.
 * Guards (zero rows = refused, the page says why): the line belongs to THIS
 * campaign; report_url is an http(s) URL; mass_mg is a positive number of mg
 * with at most two decimals; purity_pct is 0–100 with at most two decimals;
 * endotoxin, when given, is pass or fail; tested_at, when given, is a
 * YYYY-MM-DD date. Text inputs are checked by pattern BEFORE any cast (inside
 * CASE), so bad input refuses instead of raising.
 */
function addStorefrontCoaReport() {
  return action('addStorefrontCoaReport', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF({{params.group_buy_id}}::text, '')::bigint AS group_buy_id,
               NULLIF({{params.group_buy_product_id}}::text, '')::bigint AS group_buy_product_id,
               NULLIF(btrim({{params.lab}}::text), '') AS lab,
               NULLIF(btrim({{params.report_url}}::text), '') AS report_url,
               NULLIF(btrim({{params.batch_label}}::text), '') AS batch_label,
               NULLIF(btrim({{params.tested_at}}::text), '') AS tested_at_txt,
               NULLIF(btrim({{params.mass_mg}}::text), '') AS mass_txt,
               NULLIF(btrim({{params.purity_pct}}::text), '') AS purity_txt,
               NULLIF(lower(btrim({{params.endotoxin}}::text)), '') AS endotoxin_txt,
               NULLIF(btrim({{params.notes}}::text), '') AS notes,
               COALESCE(NULLIF(btrim({{params.actor}}::text), ''), 'admin') AS actor
      ), val AS (
        SELECT inp.*,
               CASE WHEN inp.tested_at_txt ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
                 CASE WHEN substr(inp.tested_at_txt, 1, 4)::int >= 1 AND substr(inp.tested_at_txt, 6, 2)::int BETWEEN 1 AND 12 THEN
                   CASE WHEN substr(inp.tested_at_txt, 9, 2)::int BETWEEN 1 AND extract(day from make_date(substr(inp.tested_at_txt, 1, 4)::int, substr(inp.tested_at_txt, 6, 2)::int, 1) + interval '1 month - 1 day')::int
                        THEN inp.tested_at_txt::date END
                 END
               END AS tested_at,
               CASE WHEN inp.mass_txt ~ '^[0-9]{1,6}(\\.[0-9]{1,2})?$' THEN inp.mass_txt::numeric END AS mass_mg,
               CASE WHEN inp.purity_txt ~ '^[0-9]{1,3}(\\.[0-9]{1,2})?$' THEN inp.purity_txt::numeric END AS purity_pct,
               CASE WHEN inp.endotoxin_txt IN ('pass', 'fail') THEN inp.endotoxin_txt END AS endotoxin
        FROM inp
      ), ins AS (
        INSERT INTO storefront.coa_reports
          (group_buy_product_id, product_id, lab, report_url, batch_label, tested_at, mass_mg, purity_pct, endotoxin, notes, created_by)
        SELECT gbp.id, NULL, v.lab, v.report_url, v.batch_label, v.tested_at, v.mass_mg, v.purity_pct, v.endotoxin, v.notes, v.actor
        FROM val v
        JOIN group_buy_products gbp ON gbp.id = v.group_buy_product_id AND gbp.group_buy_id = v.group_buy_id
        WHERE v.report_url ~* '^https?://[^/[:space:]]+([/?#][^[:space:]]*)?$'
          AND length(v.report_url) <= 2000
          AND (v.tested_at_txt IS NULL OR v.tested_at IS NOT NULL)
          -- required, both: a COA states the tested mass and the purity
          AND v.mass_mg IS NOT NULL AND v.mass_mg > 0
          AND v.purity_pct IS NOT NULL AND v.purity_pct <= 100
          AND (v.endotoxin_txt IS NULL OR v.endotoxin IS NOT NULL)
        RETURNING id, group_buy_product_id, lab, report_url, batch_label, tested_at, mass_mg, purity_pct, endotoxin, notes
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'storefront.coa_reports', ins.id::text, 'coa_report_added', v.actor,
               jsonb_build_object('group_buy_id', v.group_buy_id, 'group_buy_product_id', ins.group_buy_product_id,
                                  'lab', ins.lab, 'report_url', ins.report_url, 'batch_label', ins.batch_label,
                                  'tested_at', ins.tested_at, 'mass_mg', ins.mass_mg, 'purity_pct', ins.purity_pct,
                                  'endotoxin', ins.endotoxin, 'notes', ins.notes)
        FROM ins, val v
        RETURNING row_pk
      )
      SELECT id FROM ins
    `,
  });
}

export default addStorefrontCoaReport;
