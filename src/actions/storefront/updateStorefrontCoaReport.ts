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
 * link. Same input guards as addStorefrontCoaReport — the tested mass and the
 * purity are required (a blend's: its total and blend purity), endotoxin is
 * pass / fail / not given, and `components` is '' (not a blend: any stored
 * list is cleared) or 2–12 valid {name, mass_mg, purity_pct} (1790104900);
 * zero rows = refused.
 */
function updateStorefrontCoaReport() {
  return action('updateStorefrontCoaReport', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      -- MATERIALIZED: the inputs reach the casts below as column values, never as constants the
      -- planner would fold (a constant '[{'::jsonb is evaluated while planning, past any CASE guard)
      WITH inp AS MATERIALIZED (
        SELECT NULLIF({{params.id}}::text, '')::bigint AS id,
               NULLIF({{params.group_buy_id}}::text, '')::bigint AS group_buy_id,
               NULLIF({{params.expected_version}}::text, '') AS expected_version,
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
      ), old AS (
        -- the row as the page loaded it, in THIS campaign, locked for the update
        SELECT c.id, c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
               c.tested_at, c.mass_mg, c.purity_pct, c.endotoxin, c.components, c.notes
        FROM storefront.coa_reports c
        JOIN group_buy_products gbp ON gbp.id = c.group_buy_product_id
        JOIN val v ON v.id = c.id AND gbp.group_buy_id = v.group_buy_id
        WHERE md5(row(c.group_buy_product_id, c.lab, c.report_url, c.media_id, c.batch_label,
                      c.tested_at, c.mass_mg, c.purity_pct, c.endotoxin, c.components, c.notes)::text) = v.expected_version
        FOR UPDATE OF c
      ), upd AS (
        UPDATE storefront.coa_reports c SET
          lab = v.lab,
          report_url = v.report_url,
          batch_label = v.batch_label,
          tested_at = v.tested_at,
          mass_mg = v.mass_mg,
          purity_pct = v.purity_pct,
          endotoxin = v.endotoxin,
          components = CASE WHEN v.components_txt IS NULL THEN NULL ELSE cp.j END,
          notes = v.notes
        FROM old o, val v, comp cp
        WHERE c.id = o.id
          AND ((v.report_url ~* '^https?://[^/[:space:]]+([/?#][^[:space:]]*)?$' AND length(v.report_url) <= 2000)
               OR (v.report_url IS NULL AND o.media_id IS NOT NULL))
          AND (v.tested_at_txt IS NULL OR v.tested_at IS NOT NULL)
          -- required, both: a COA states the tested mass and the purity (a blend's: its total and blend purity)
          AND v.mass_mg IS NOT NULL AND v.mass_mg > 0
          AND v.purity_pct IS NOT NULL AND v.purity_pct <= 100
          AND (v.endotoxin_txt IS NULL OR v.endotoxin IS NOT NULL)
          -- a blend: 2–12 components, every one valid, no name twice
          AND (v.components_txt IS NULL
               OR (v.components_in IS NOT NULL AND cp.n BETWEEN 2 AND 12 AND cp.n_ok = cp.n AND cp.n_names = cp.n))
        RETURNING c.id, c.group_buy_product_id, c.lab, c.report_url, c.batch_label, c.tested_at, c.mass_mg, c.purity_pct, c.endotoxin, c.components, c.notes
      ), audit AS (
        INSERT INTO audit_log (table_name, row_pk, action, actor, old_data, new_data)
        SELECT 'storefront.coa_reports', upd.id::text, 'coa_report_updated', v.actor,
               jsonb_build_object('lab', o.lab, 'report_url', o.report_url, 'batch_label', o.batch_label,
                                  'tested_at', o.tested_at, 'mass_mg', o.mass_mg, 'purity_pct', o.purity_pct,
                                  'endotoxin', o.endotoxin, 'components', o.components, 'notes', o.notes),
               jsonb_build_object('group_buy_id', v.group_buy_id, 'group_buy_product_id', upd.group_buy_product_id,
                                  'lab', upd.lab, 'report_url', upd.report_url, 'batch_label', upd.batch_label,
                                  'tested_at', upd.tested_at, 'mass_mg', upd.mass_mg, 'purity_pct', upd.purity_pct,
                                  'endotoxin', upd.endotoxin, 'components', upd.components, 'notes', upd.notes)
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
