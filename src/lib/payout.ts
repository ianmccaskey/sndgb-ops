/**
 * Per-party payout math, shared by the Financials overview, the Dispersion
 * tab and the dashboard P&L block — ONE place, so the three can never
 * disagree about what a party is owed.
 *
 * v_group_buy_pnl.net_profit_usd already has GROUP STOCK (stock-plan
 * commits and group-stock adjustments, at cost + freight) taken out: the
 * group buys its own kits out of profit. That cost is NOT borne by the
 * profit split, though — the partners fund it EQUALLY (Ian, 2026-10-24:
 * "funds for that should be allocated 50/50 between me and Paige"). So a
 * party's payout is
 *
 *   pct × (net + group_stock)  −  group_stock / N  −  personal deductions
 *
 * the split applies to profit BEFORE the group bought its stock, then each
 * of the N split parties pays an equal share of that stock. The parties'
 * payouts still sum to net − Σpersonal exactly; only the division between
 * them moves. "Equal" means 1/N of the CURRENT split parties — two parties
 * today, so 50/50; a third would make it thirds without a code change.
 *
 * All splitting is in integer CENTS and the LAST party absorbs the rounding
 * residue, so per-row shares always sum to the row total (the established
 * convention from the dispersion tab).
 */

export type Split = { party: string; pct: string | number };

export const cents = (usd: number) => Math.round(usd * 100);

/** Split a total by the profit-split percentages. */
export function prorateByPct(totalUsd: number, splits: Split[]): Record<string, number> {
  const totalC = cents(totalUsd);
  const out: Record<string, number> = {};
  let used = 0;
  splits.forEach((s, i) => {
    const share = i === splits.length - 1 ? totalC - used : Math.floor(totalC * Number(s.pct) / 100);
    out[s.party] = share / 100;
    used += share;
  });
  return out;
}

/** Split a total EQUALLY among the split parties (group stock). */
export function equalShares(totalUsd: number, splits: Split[]): Record<string, number> {
  const totalC = cents(totalUsd);
  const out: Record<string, number> = {};
  let used = 0;
  splits.forEach((s, i) => {
    const share = i === splits.length - 1 ? totalC - used : Math.floor(totalC / splits.length);
    out[s.party] = share / 100;
    used += share;
  });
  return out;
}

/** The equal-share percentage, for labels ("50%" with two parties). */
export const equalPct = (splits: Split[]) => (splits.length > 0 ? 100 / splits.length : 0);

export type PartyPayout = {
  /** pct × (net + group stock): the party's split of profit BEFORE the group bought its stock */
  base: number;
  /** the party's equal share of group stock */
  stockShare: number;
  /** base − stockShare: what the split owes the party before personal deductions */
  beforePersonal: number;
  /** personal adjustments (GB-priced units + personal at-cost stock) */
  personal: number;
  /** beforePersonal − personal */
  payout: number;
};

export function partyPayouts(
  netUsd: number,
  groupStockUsd: number,
  splits: Split[],
  personalByParty: (party: string) => number,
): Record<string, PartyPayout> {
  const bases = prorateByPct(netUsd + groupStockUsd, splits);
  const stock = equalShares(groupStockUsd, splits);
  const out: Record<string, PartyPayout> = {};
  for (const s of splits) {
    const base = bases[s.party] || 0;
    const stockShare = stock[s.party] || 0;
    const personal = personalByParty(s.party);
    const beforePersonal = Math.round((base - stockShare) * 100) / 100;
    out[s.party] = { base, stockShare, beforePersonal, personal, payout: Math.round((beforePersonal - personal) * 100) / 100 };
  }
  return out;
}
