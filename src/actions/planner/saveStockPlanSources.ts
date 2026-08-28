import { action } from '@uibakery/data';

/**
 * Upsert the plan's source figures. Guards (zero rows = refused): every
 * amount is a clean 2-decimal non-negative string, and the attributable
 * outside slice can never exceed what the outside wallet holds (also a
 * table CHECK — this guard turns the violation into a quiet refusal
 * instead of a raw constraint error). Audited.
 */
function saveStockPlanSources() {
  return action('saveStockPlanSources', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH up AS (
        INSERT INTO stock_plans (group_buy_id, outside_total_usd, outside_max_usd, cash_assignable_usd, updated_by, updated_at)
        SELECT {{params.group_buy_id}}::bigint,
               ({{params.outside_total_usd}})::numeric,
               ({{params.outside_max_usd}})::numeric,
               ({{params.cash_assignable_usd}})::numeric,
               {{params.actor}}::text, now()
        WHERE ({{params.outside_total_usd}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.outside_max_usd}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.cash_assignable_usd}})::text ~ '^[0-9]+(\\.[0-9]{1,2})?$'
          AND ({{params.outside_max_usd}})::numeric <= ({{params.outside_total_usd}})::numeric
        ON CONFLICT (group_buy_id) DO UPDATE SET
          outside_total_usd = EXCLUDED.outside_total_usd,
          outside_max_usd = EXCLUDED.outside_max_usd,
          cash_assignable_usd = EXCLUDED.cash_assignable_usd,
          updated_by = EXCLUDED.updated_by,
          updated_at = now()
        RETURNING id, outside_total_usd, outside_max_usd, cash_assignable_usd
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'stock_plans', up.id::text, 'stock_plan_sources_saved', {{params.actor}}::text,
             jsonb_build_object('outside_total_usd', up.outside_total_usd,
                                'outside_max_usd', up.outside_max_usd,
                                'cash_assignable_usd', up.cash_assignable_usd)
      FROM up
      RETURNING row_pk AS id
    `,
  });
}

export default saveStockPlanSources;
