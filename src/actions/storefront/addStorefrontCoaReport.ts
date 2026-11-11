import { action } from '@uibakery/data';

/**
 * Attach a lab report to one line of the selected campaign. One row, audited.
 *
 * The report is a link to the lab-hosted COA (http/https only); PDF uploads
 * (media_id) are not written here. Every report states the TESTED MASS and
 * the PURITY (Ian, 2026-11-09; the table's coa_reports_mass_and_purity CHECK,
 * 1790104000), and the endotoxin screening's outcome when the lab ran one.
 * A BLEND's report (1790104900) states those for the blend — its total
 * quantity and blend purity — and lists its components, each with its own
 * mass and purity: `components` is '' for a single-substance report, else a
 * JSON array of 2–12 {name, mass_mg, purity_pct} (figures as text, so the
 * decimals arrive as typed) in the report's order.
 * Guards (zero rows = refused, the page says why): the line belongs to THIS
 * campaign; report_url is an http(s) URL; mass_mg is a positive number of mg
 * with at most three decimals; purity_pct is 0–100 with at most three
 * decimals; endotoxin, when given, is pass or fail; tested_at, when given, is
 * a YYYY-MM-DD date; components, when given, is valid JSON with 2–12 entries,
 * each named (1–60 characters, no control characters, unique ignoring case)
 * with a mass and a purity under the same rules. Text inputs are checked by
 * pattern (or pg_input_is_valid) BEFORE any cast (inside CASE), so bad input
 * refuses instead of raising; the table's coa_reports_components CHECK holds
 * every other writer to the same shape.
 */
function addStorefrontCoaReport() {
  return action('addStorefrontCoaReport', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      -- MATERIALIZED: the inputs reach the casts below as column values, never as constants the
      -- planner would fold (a constant '[{'::jsonb is evaluated while planning, past any CASE guard)
      WITH inp AS MATERIALIZED (
        SELECT NULLIF({{params.group_buy_id}}::text, '')::bigint AS group_buy_id,
               NULLIF({{params.group_buy_product_id}}::text, '')::bigint AS group_buy_product_id,
               NULLIF(btrim({{params.lab}}::text), '') AS lab,
               NULLIF(btrim({{params.report_url}}::text), '') AS report_url,
               NULLIF(btrim({{params.batch_label}}::text), '') AS batch_label,
               NULLIF(btrim({{params.tested_at}}::text), '') AS tested_at_txt,
               NULLIF(btrim({{params.mass_mg}}::text), '') AS mass_txt,
               NULLIF(btrim({{params.purity_pct}}::text), '') AS purity_txt,
               NULLIF(lower(btrim({{params.endotoxin}}::text)), '') AS endotoxin_txt,
               NULLIF(btrim({{params.components}}::text), '') AS components_txt,
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
               CASE WHEN inp.mass_txt ~ '^[0-9]{1,6}(\\.[0-9]{1,3})?$' THEN inp.mass_txt::numeric END AS mass_mg,
               CASE WHEN inp.purity_txt ~ '^[0-9]{1,3}(\\.[0-9]{1,3})?$' THEN inp.purity_txt::numeric END AS purity_pct,
               CASE WHEN inp.endotoxin_txt IN ('pass', 'fail') THEN inp.endotoxin_txt END AS endotoxin,
               -- the list as JSON only when it parses and is an array (nested CASE: the cast never runs on bad text)
               CASE WHEN pg_input_is_valid(inp.components_txt, 'jsonb') THEN
                 CASE WHEN jsonb_typeof(inp.components_txt::jsonb) = 'array' THEN inp.components_txt::jsonb END
               END AS components_in
        FROM inp
      ), comp AS (
        -- a blend's components, each checked and rebuilt with numeric figures; one row, n = 0 when not a blend
        SELECT count(*) AS n,
               count(*) FILTER (WHERE el.ok) AS n_ok,
               count(DISTINCT lower(el.name)) FILTER (WHERE el.ok) AS n_names,
               jsonb_agg(jsonb_build_object('name', el.name, 'mass_mg', el.mass_mg, 'purity_pct', el.purity_pct) ORDER BY el.ord)
                 FILTER (WHERE el.ok) AS j
        FROM val v
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(v.components_in, '[]'::jsonb)) WITH ORDINALITY AS x(e, ord)
        CROSS JOIN LATERAL (
          SELECT btrim(x.e ->> 'name') AS name, btrim(x.e ->> 'mass_mg') AS mass_txt, btrim(x.e ->> 'purity_pct') AS purity_txt
        ) t
        CROSS JOIN LATERAL (
          SELECT x.ord, t.name,
                 CASE WHEN t.mass_txt ~ '^[0-9]{1,6}(\\.[0-9]{1,3})?$' THEN t.mass_txt::numeric END AS mass_mg,
                 CASE WHEN t.purity_txt ~ '^[0-9]{1,3}(\\.[0-9]{1,3})?$' THEN t.purity_txt::numeric END AS purity_pct
        ) f
        CROSS JOIN LATERAL (
          SELECT f.ord, f.name, f.mass_mg, f.purity_pct,
                 (jsonb_typeof(x.e) = 'object'
                  AND f.name IS NOT NULL AND length(f.name) BETWEEN 1 AND 60 AND f.name !~ '[[:cntrl:]]'
                  AND f.mass_mg IS NOT NULL AND f.mass_mg > 0
                  AND f.purity_pct IS NOT NULL AND f.purity_pct <= 100) IS TRUE AS ok
        ) el
      ), ins AS (
        INSERT INTO storefront.coa_reports
          (group_buy_product_id, product_id, lab, report_url, batch_label, tested_at, mass_mg, purity_pct, endotoxin, components, notes, created_by)
        SELECT gbp.id, NULL, v.lab, v.report_url, v.batch_label, v.tested_at, v.mass_mg, v.purity_pct, v.endotoxin,
               CASE WHEN v.components_txt IS NULL THEN NULL ELSE c.j END, v.notes, v.actor
        FROM val v
        CROSS JOIN comp c
        JOIN group_buy_products gbp ON gbp.id = v.group_buy_product_id AND gbp.group_buy_id = v.group_buy_id
        WHERE v.report_url ~* '^https?://[^/[:space:]]+([/?#][^[:space:]]*)?$'
          AND length(v.report_url) <= 2000
          AND (v.tested_at_txt IS NULL OR v.tested_at IS NOT NULL)
          -- required, both: a COA states the tested mass and the purity (a blend's: its total and blend purity)
          AND v.mass_mg IS NOT NULL AND v.mass_mg > 0
          AND v.purity_pct IS NOT NULL AND v.purity_pct <= 100
          AND (v.endotoxin_txt IS NULL OR v.endotoxin IS NOT NULL)
          -- a blend: 2–12 components, every one valid, no name twice
          AND (v.components_txt IS NULL
               OR (v.components_in IS NOT NULL AND c.n BETWEEN 2 AND 12 AND c.n_ok = c.n AND c.n_names = c.n))
        RETURNING id, group_buy_product_id, lab, report_url, batch_label, tested_at, mass_mg, purity_pct, endotoxin, components, notes
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
        SELECT 'storefront.coa_reports', ins.id::text, 'coa_report_added', v.actor,
               jsonb_build_object('group_buy_id', v.group_buy_id, 'group_buy_product_id', ins.group_buy_product_id,
                                  'lab', ins.lab, 'report_url', ins.report_url, 'batch_label', ins.batch_label,
                                  'tested_at', ins.tested_at, 'mass_mg', ins.mass_mg, 'purity_pct', ins.purity_pct,
                                  'endotoxin', ins.endotoxin, 'components', ins.components, 'notes', ins.notes)
        FROM ins, val v
        RETURNING row_pk
      )
      SELECT id FROM ins
    `,
  });
}

export default addStorefrontCoaReport;
