import { action } from '@uibakery/data';

/**
 * Audited admin adjustment for an item that is NOT a campaign product
 * ("Other" in the product picker, 1790102300): a named item bought from
 * one of the campaign's vendors at a typed unit cost, assigned like any
 * at-cost row —
 *   - a party          → PERSONAL: expected_usd deducts from that party's
 *                        payout (P&L neutral);
 *   - 'both' + stock   → GROUP STOCK: expected_usd comes out of net profit
 *                        (v_group_buy_pnl.other_stock_usd), funded equally
 *                        by the partners like every group-stock row;
 *   - 'both', no stock → OUTSIDE CUSTOMER: a receivable until marked
 *                        received.
 * The vendor is owed the cost in every case (v_vendor_balances); nothing
 * joins demand, MOQ, kits or freight — the typed cost is the landed cost.
 *
 * Guards (zero rows = refused): a non-blank name; a positive 2dp unit cost;
 * a positive WHOLE qty; a vendor that is ACTIVE and has a product line in
 * THIS campaign (so the vendor balance row that must carry the cost
 * exists); a party beneficiary must be one of this campaign's split
 * parties; stock requires beneficiary 'both'; a reason is required except
 * for group stock (the "P² Stock" button sends none and the row records
 * 'P² stock', as for campaign products).
 */
function addOtherAdjustment() {
  return action('addOtherAdjustment', 'SQL', {
    datasourceName: 'SND GB DB',
    query: `
      WITH inp AS (
        SELECT NULLIF(btrim({{params.other_name}}::text), '') AS other_name,
               CASE WHEN btrim({{params.unit_cost_usd}}::text) ~ '^[0-9]+(\\.[0-9]{1,2})?$' THEN btrim({{params.unit_cost_usd}}::text)::numeric END AS unit_cost,
               CASE WHEN btrim({{params.qty}}::text) ~ '^[0-9]+$' THEN btrim({{params.qty}}::text)::numeric END AS qty,
               NULLIF({{params.vendor_id}}::text, '')::bigint AS vendor_id,
               {{params.beneficiary}}::text AS beneficiary,
               COALESCE(NULLIF({{params.stock}}::text, ''), 'false') = 'true' AS stock,
               NULLIF(btrim({{params.reason}}::text), '') AS reason
      ), ins AS (
        INSERT INTO admin_adjustments (group_buy_product_id, group_buy_id, qty, reason, created_by, beneficiary, pricing, expected_usd, preordered, stock,
                                       other_name, other_unit_cost_usd, vendor_id)
        SELECT NULL,
               {{params.group_buy_id}}::bigint,
               inp.qty,
               COALESCE(inp.reason, CASE WHEN inp.stock THEN 'P² stock' END),
               {{params.created_by}}::text,
               inp.beneficiary,
               'cost',
               ROUND(inp.qty * inp.unit_cost, 2),
               false,
               inp.stock,
               inp.other_name,
               inp.unit_cost,
               inp.vendor_id
        FROM inp
        WHERE inp.other_name IS NOT NULL
          AND inp.unit_cost IS NOT NULL AND inp.unit_cost > 0
          AND inp.qty IS NOT NULL AND inp.qty > 0
          AND (inp.reason IS NOT NULL OR inp.stock)
          -- the vendor must be live in THIS campaign: v_vendor_balances is
          -- keyed by the vendor's product lines, and that is the row the
          -- cost must land on so paying for the item reconciles
          AND EXISTS (
            SELECT 1 FROM vendors v
            JOIN group_buy_products gbp ON gbp.vendor_id = v.id
            WHERE v.id = inp.vendor_id
              AND v.active
              AND gbp.group_buy_id = {{params.group_buy_id}}::bigint
          )
          AND EXISTS (SELECT 1 FROM group_buys gb WHERE gb.id = {{params.group_buy_id}}::bigint)
          -- group stock belongs to both partners; a party row names one of
          -- THIS campaign's split parties, or its value deducts from no one
          AND (NOT inp.stock OR inp.beneficiary = 'both')
          AND (inp.beneficiary = 'both'
               OR EXISTS (
                 SELECT 1 FROM profit_splits ps
                 WHERE ps.group_buy_id = {{params.group_buy_id}}::bigint
                   AND ps.party = inp.beneficiary
               ))
        RETURNING id, group_buy_id, qty, reason, beneficiary, stock, expected_usd, other_name, other_unit_cost_usd, vendor_id
      )
      INSERT INTO audit_log (table_name, row_pk, action, actor, new_data)
      SELECT 'admin_adjustments', ins.id::text, 'other_adjustment_added', {{params.created_by}}::text,
             jsonb_build_object('group_buy_id', ins.group_buy_id, 'other_name', ins.other_name, 'vendor_id', ins.vendor_id,
                                'unit_cost_usd', ins.other_unit_cost_usd, 'qty', ins.qty, 'expected_usd', ins.expected_usd,
                                'beneficiary', ins.beneficiary, 'stock', ins.stock, 'reason', ins.reason)
      FROM ins
      RETURNING row_pk AS id
    `,
  });
}

export default addOtherAdjustment;
