import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listVendors from '@/actions/vendors/listVendors';
import listVendorBalances from '@/actions/vendors/listVendorBalances';
import listVendorPayments from '@/actions/vendors/listVendorPayments';
import listVendorProductProgress from '@/actions/vendors/listVendorProductProgress';
import addVendorPaymentBatch from '@/actions/vendors/addVendorPaymentBatch';
import deleteVendorPayment from '@/actions/vendors/deleteVendorPayment';
import deleteVendorPaymentBatch from '@/actions/vendors/deleteVendorPaymentBatch';
import saveVendor from '@/actions/vendors/saveVendor';
import listWallets from '@/actions/financials/listWallets';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtUSD, fmtDate, fmtNum } from '@/lib/fmt';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StatusPill } from '@/components/StatusPill';
import { Switch } from '@/components/ui/switch';
import { Store, AlertTriangle } from 'lucide-react';
import { Field } from '@/components/Field';

type Vendor = { id: number; code: string; name: string; active: boolean };
type Balance = {
  vendor_id: number; vendor_code: string; owed_usd: string; paid_usd: string;
  balance_usd: string; pay_status: string;
  product_owed_usd: string; freight_demand_usd: string; kits_demand: string;
  kits_paid: string; freight_paid_usd: string;
};
type Send = { id: number; wallet_name: string; chain: string; amount_usd: string; method: string | null; tx_ref: string | null };
type Payment = {
  id: number; paid_on: string; amount_usd: string; method: string | null;
  receipt_ref: string | null; note: string | null; vendor_code: string; wallet_name: string | null;
  kits_qty: string | null; freight_usd: string | null; sku_code: string | null;
  // a line of a batched payment (1790102100): the money is on the batch's
  // sends, repeated on every line of the batch; the log shows them once
  batch_id: number | null; sends: Send[] | null;
};
type Wallet = { id: number; name: string; chain: string; active: boolean };
type ProductProgress = {
  group_buy_product_id: number; vendor_code: string; sku_code: string;
  kits_demand: string; kits_paid: string; vendor_order_value_usd: string; per_kit_cost_usd: string;
  orders_kits: string; adj_kits: string;
  adj_detail: { kind: string; qty: string }[] | null;
};

// admin-adjustment kinds get distinct chips so it's visible at a glance
// that their kits are INSIDE the purchase numbers (color never the only
// signal — every chip carries its kind label and signed kit count)
const ADJ_CHIP_STYLES: [RegExp, string][] = [
  [/^stock plan$/, 'bg-emerald-400/10 text-emerald-300'],
  [/^group stock$/, 'bg-emerald-400/10 text-emerald-300'],
  [/^outside sale$/, 'bg-sky-400/10 text-sky-300'],
  [/^personal/, 'bg-indigo-400/10 text-indigo-300'],
  [/^admin$/, 'bg-slate-400/10 text-slate-300'],
];
const adjChipClass = (kind: string) =>
  (ADJ_CHIP_STYLES.find(([re]) => re.test(kind)) || [null, 'bg-slate-400/10 text-slate-300'])[1];

export function VendorsPage() {
  const { groupBuyId, userName } = useApp();
  const enabled = groupBuyId != null;
  const [rawVendors, , , reloadVendors] = useLoadAction(listVendors, [], {});
  const [rawBalances, , , reloadBalances] = useLoadAction(listVendorBalances, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawPayments, , , reloadPayments] = useLoadAction(listVendorPayments, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawWallets] = useLoadAction(listWallets, [], {});
  const [rawProgress, , , reloadProgress] = useLoadAction(listVendorProductProgress, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });

  const vendors = rows<Vendor>(rawVendors);
  const balances = rows<Balance>(rawBalances);
  const payments = rows<Payment>(rawPayments);
  const wallets = rows<Wallet>(rawWallets);
  const productProgress = rows<ProductProgress>(rawProgress);

  const [doPayBatch] = useMutateAction(addVendorPaymentBatch);
  const [doSaveVendor] = useMutateAction(saveVendor);
  const [doDeletePayment] = useMutateAction(deleteVendorPayment);
  const [doDeleteBatch] = useMutateAction(deleteVendorPaymentBatch);

  const [pVendor, setPVendor] = useState('');
  const [pDate, setPDate] = useState('');
  const [pNote, setPNote] = useState('');
  // one payment = one or more product lines; each line's value auto-computes
  // from kits × the product's current per-kit vendor cost, editable for
  // discounts. The whole payment (lines, freight, sends) is recorded as ONE
  // batch, all or nothing.
  type PayLine = { product: string; kits: string; value: string; valueDirty: boolean };
  const blankLine = (): PayLine => ({ product: '', kits: '', value: '', valueDirty: false });
  const [pLines, setPLines] = useState<PayLine[]>([blankLine()]);
  const [pFreight, setPFreight] = useState('');
  // the SENDS that carried the money: one per on-chain transfer, each from
  // its own wallet (rail) — a payment made as "$20,000 on SOL + $13,025 on
  // ETH" is two sends on one batch (Ian, 2026-10-26). Their total must
  // equal the lines + freight total; the server refuses otherwise.
  type PaySend = { wallet: string; amount: string; amountDirty: boolean; method: string; ref: string };
  const blankSend = (): PaySend => ({ wallet: '', amount: '', amountDirty: false, method: 'USDC', ref: '' });
  const [pSends, setPSends] = useState<PaySend[]>([blankSend()]);
  const [pError, setPError] = useState('');
  const [pSaving, setPSaving] = useState(false);

  const [nvCode, setNvCode] = useState('');
  const [nvError, setNvError] = useState('');

  const overpaid = balances.filter(b => b.pay_status === 'OVERPAID');

  // what buying the REST actually costs, per vendor: each product's
  // remaining kits × its (blended) per-kit cost, clamped at zero per
  // product — unlike the netted Balance column, an over-payment on one
  // product can never make the other products' remaining kits look cheaper
  const remainingProductUsd = (vendorCode: string) =>
    Math.round(productProgress
      .filter(pp => pp.vendor_code === vendorCode)
      .reduce((s, pp) =>
        s + Math.max(Number(pp.kits_demand) - Number(pp.kits_paid), 0) * Number(pp.per_kit_cost_usd), 0) * 100) / 100;

  // a COA vendor's campaign products are ALL COA-prefixed (the same SKU
  // convention the wallet-coverage math scopes by); a vendor with any real
  // product line stays in the product section
  const [showCoaLines, setShowCoaLines] = useState(false);
  const isCoaVendor = (code: string) => {
    const pps = productProgress.filter(pp => pp.vendor_code === code);
    return pps.length > 0 && pps.every(pp => /^coa/i.test(pp.sku_code));
  };
  const productBalances = balances.filter(b => !isCoaVendor(b.vendor_code));
  const coaBalances = balances.filter(b => isCoaVendor(b.vendor_code));

  const vendorCode = vendors.find(v => String(v.id) === pVendor)?.code || '';
  const vendorProducts = productProgress.filter(pp => pp.vendor_code === vendorCode);

  const setLine = (i: number, patch: Partial<PayLine>) => {
    setPLines(ls => ls.map((l, j) => {
      if (j !== i) return l;
      const next = { ...l, ...patch };
      // kits or product changed and the operator has not hand-edited the
      // value: recompute kits × per-kit vendor cost
      if (!next.valueDirty && (patch.kits !== undefined || patch.product !== undefined)) {
        const pp = vendorProducts.find(v => String(v.group_buy_product_id) === next.product);
        const kits = Number(next.kits);
        next.value = pp && kits > 0 ? (Math.round(kits * Number(pp.per_kit_cost_usd) * 100) / 100).toFixed(2) : '';
      }
      return next;
    }));
  };

  const linesTotal = pLines.reduce((sum, l) => sum + (Number(l.value) > 0 ? Number(l.value) : 0), 0);
  const paymentTotal = Math.round((linesTotal + (Number(pFreight) > 0 ? Number(pFreight) : 0)) * 100) / 100;

  const setSend = (i: number, patch: Partial<PaySend>) =>
    setPSends(ss => ss.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  // the FIRST send the operator has not hand-typed an amount into takes
  // whatever the typed sends leave of the total: a single-rail payment
  // needs no amount typed at all, a two-rail one needs only the first.
  // Clearing a typed amount hands the field back to the auto-fill.
  const typedSum = pSends.reduce((s, x) => s + (x.amountDirty && Number(x.amount) > 0 ? Number(x.amount) : 0), 0);
  const autoIdx = pSends.findIndex(x => !x.amountDirty);
  const autoAmount = Math.round((paymentTotal - typedSum) * 100) / 100;
  const sendAmount = (i: number) =>
    pSends[i].amountDirty ? pSends[i].amount : (i === autoIdx && autoAmount > 0 ? autoAmount.toFixed(2) : '');
  const sendsTotal = Math.round(pSends.reduce((s, _, i) => s + (Number(sendAmount(i)) > 0 ? Number(sendAmount(i)) : 0), 0) * 100) / 100;
  const sendsMatch = Math.round(sendsTotal * 100) === Math.round(paymentTotal * 100);

  const recordPayment = async () => {
    const active = pLines.filter(l => l.product || l.kits.trim() || l.value.trim());
    if (!pVendor || !pDate) { setPError('Vendor and date are required.'); return; }
    if (active.length === 0 && !(Number(pFreight) > 0)) { setPError('Add at least one product line (or freight).'); return; }
    for (const l of active) {
      if (!l.product) { setPError('Every line needs a product.'); return; }
      if (!/^\d+(?:\.\d{1,2})?$/.test(l.kits.trim()) || !(Number(l.kits) > 0)) { setPError('Every line needs a positive kit count (max 2 decimals).'); return; }
      if (!/^\d+(?:\.\d{1,2})?$/.test(l.value.trim()) || !(Number(l.value) > 0)) { setPError('Every line needs a positive $ value (max 2 decimals).'); return; }
    }
    if (pFreight.trim() !== '' && (!/^\d+(?:\.\d{1,2})?$/.test(pFreight.trim()) || !(Number(pFreight) >= 0))) { setPError('Freight must be a dollar amount with at most 2 decimals.'); return; }
    const sends = pSends
      .map((s, i) => ({ ...s, amount: sendAmount(i) }))
      .filter(s => s.wallet || s.amount.trim() || s.ref.trim());
    if (sends.length === 0) { setPError('Add at least one send — the wallet the money left from.'); return; }
    for (const s of sends) {
      if (!s.wallet) { setPError('Every send needs a wallet.'); return; }
      if (!/^\d+(?:\.\d{1,2})?$/.test(s.amount.trim()) || !(Number(s.amount) > 0)) { setPError('Every send needs a positive $ amount (max 2 decimals).'); return; }
    }
    const sendsCents = sends.reduce((c, s) => c + Math.round(Number(s.amount) * 100), 0);
    if (sendsCents !== Math.round(paymentTotal * 100)) {
      setPError(`Sends total ${fmtUSD(sendsCents / 100)} must equal the lines + freight total ${fmtUSD(paymentTotal)}.`);
      return;
    }
    // deliberate over-buys (stocking beyond current demand) are allowed, but
    // only through an explicit confirmation — the server cap stays on for
    // anything not confirmed, so a typo still refuses. The owed figure the
    // user confirms AGAINST travels with the line: the server re-reads owed
    // under its lock and refuses if it shrank meanwhile, so a concurrent
    // recorder can never silently widen a confirmed over-buy.
    const kitsOwed = (l: PayLine) => {
      const pp = vendorProducts.find(v => String(v.group_buy_product_id) === l.product);
      return pp ? Math.round((Number(pp.kits_demand) - Number(pp.kits_paid)) * 100) / 100 : null;
    };
    const overLines = new Set(active.filter(l => {
      const owed = kitsOwed(l);
      return owed !== null && Number(l.kits) > owed;
    }));
    if (overLines.size > 0) {
      const detail = [...overLines].map(l => {
        const pp = vendorProducts.find(v => String(v.group_buy_product_id) === l.product)!;
        return `${pp.sku_code}: ${l.kits} kits, but only ${fmtNum(Math.max(kitsOwed(l)!, 0))} still owed`;
      }).join('\n');
      if (!window.confirm(`These lines exceed what is currently owed:\n\n${detail}\n\nRecord anyway? The vendor breakdown will flag them as over-paid.`)) return;
    }
    // freight beyond what the demand ledger says is owed (vendor added fees,
    // surcharges) is allowed the same way as kit over-buys: an explicit
    // confirmation whose owed figure travels with the payment — the server
    // re-reads freight-remaining under its lock and refuses a stale
    // confirmation rather than widening the over-payment silently
    const vendorBal = balances.find(b => String(b.vendor_id) === pVendor);
    const freightOwed = vendorBal ? Math.round((Number(vendorBal.freight_demand_usd) - Number(vendorBal.freight_paid_usd)) * 100) / 100 : null;
    const freightOver = Number(pFreight) > 0 && freightOwed !== null && Number(pFreight) > freightOwed;
    if (freightOver) {
      const ledgerLine = freightOwed! >= 0
        ? `only ${fmtUSD(freightOwed!)} of freight is still owed by the demand ledger`
        : `the freight ledger is already over-paid by ${fmtUSD(-freightOwed!)}`;
      if (!window.confirm(`Freight ${fmtUSD(Number(pFreight))} exceeds the ledger: ${ledgerLine}.\n\nVendor-added fees are a valid reason. Record anyway? The vendor breakdown will flag the freight as over-paid.`)) return;
    }
    setPSaving(true); setPError('');
    try {
      // ONE batch: lines + freight + sends insert together or not at all,
      // so the form never holds a half-recorded payment. A refusal names
      // every problem; the owed figures reload so pressing Record again
      // raises the override confirmation when that was the reason.
      const res = await doPayBatch({
        vendor_id: Number(pVendor), group_buy_id: groupBuyId, paid_on: pDate, note: pNote,
        lines: JSON.stringify(active.map(l => ({
          group_buy_product_id: l.product, kits_qty: l.kits.trim(), amount_usd: l.value.trim(),
          allow_over: overLines.has(l) ? 'true' : '',
          confirmed_owed: overLines.has(l) ? String(kitsOwed(l) ?? '') : '',
        }))),
        freight_usd: pFreight.trim(),
        allow_over_freight: freightOver ? 'true' : '',
        confirmed_freight_owed: freightOver ? String(freightOwed ?? '') : '',
        sends: JSON.stringify(sends.map(s => ({
          wallet_id: s.wallet, amount_usd: s.amount.trim(), method: s.method.trim(), tx_ref: s.ref.trim(),
        }))),
        actor: userName,
      }) as { batch_id: number | string | null; refused: { what: string; why: string }[] | null }[] | null;
      const row = Array.isArray(res) ? res[0] : null;
      if (row && row.batch_id != null) {
        setPLines([blankLine()]); setPFreight(''); setPSends([blankSend()]); setPNote('');
      } else {
        const why = (row?.refused || []).map(r => `${r.what}: ${r.why}`).join('; ');
        setPError('Not recorded — nothing was written. ' + (why || 'The server refused the payment.'));
      }
    } catch (e: unknown) {
      setPError(e instanceof Error ? e.message : 'Failed to record payment');
    } finally {
      reloadBalances(); reloadPayments(); reloadProgress();
      setPSaving(false);
    }
  };

  const addNewVendor = async () => {
    const code = nvCode.trim().toUpperCase();
    if (!code) { setNvError('Code required'); return; }
    setNvError('');
    try {
      await doSaveVendor({ code, name: code, notes: '', active: true });
      setNvCode('');
      reloadVendors();
    } catch (e: unknown) {
      setNvError(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2 text-gradient">
          <Store className="h-6 w-6 text-cyan-300" /> Vendors
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Balances are computed from final counts × unit cost; payments are logged, never typed over.</p>
      </div>

      {overpaid.length > 0 && (
        <div className="rounded border border-rose-400/40 bg-rose-400/10 p-3 text-sm text-rose-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          <span><span className="font-semibold">{overpaid.map(o => o.vendor_code).join(', ')}</span> {overpaid.length === 1 ? 'is' : 'are'} OVERPAID — money went out beyond what's owed.</span>
        </div>
      )}

      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor</TableHead>
              <TableHead className="text-right">Owed</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead className="text-right">Kits left</TableHead>
              <TableHead className="text-right">Freight left</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(() => {
              const vendorRows = (b: Balance, withLines: boolean) => (
                <React.Fragment key={b.vendor_id}>
                <TableRow>
                  <TableCell className="font-medium">{b.vendor_code}</TableCell>
                  <TableCell className="text-right">{fmtUSD(b.owed_usd)}</TableCell>
                  <TableCell className="text-right">{fmtUSD(b.paid_usd)}</TableCell>
                  <TableCell className={`text-right font-medium ${parseFloat(b.balance_usd) < 0 ? 'text-rose-400' : ''}`}>
                    {fmtUSD(b.balance_usd)}
                    {(() => {
                      const rem = remainingProductUsd(b.vendor_code);
                      // only shown when it differs from the netted balance —
                      // that difference is exactly the over-payments hiding
                      // inside the aggregate (plus freight, tracked in its
                      // own column)
                      return rem > 0 ? (
                        <span className="block text-[10px] text-violet-300 font-normal whitespace-nowrap"
                          title="Sum over products of remaining kits × per-kit cost, clamped at zero per product — what buying the rest actually costs. Over-payments on one product do not offset other products here; freight is tracked separately in Freight left.">
                          product left to buy {fmtUSD(rem)}
                        </span>
                      ) : null;
                    })()}
                  </TableCell>
                  <TableCell className="text-right">
                    {(() => {
                      const left = Number(b.kits_demand) - Number(b.kits_paid);
                      const vendorAdj = productProgress
                        .filter(pp => pp.vendor_code === b.vendor_code)
                        .reduce((s, pp) => s + Number(pp.adj_kits), 0);
                      return (
                        <span className={left === 0 ? 'text-emerald-300' : left < 0 ? 'text-amber-300 font-medium' : ''}>
                          {left < 0 ? `over by ${fmtNum(-left)}` : fmtNum(left)}
                          <span className="block text-[10px] text-muted-foreground font-normal">{fmtNum(b.kits_paid)}/{fmtNum(b.kits_demand)} paid</span>
                          {vendorAdj !== 0 && (
                            <span className="block text-[10px] text-indigo-700 font-normal whitespace-nowrap"
                              title="Kits this vendor's demand includes from admin adjustments — see the product lines below for the per-kind split">
                              incl. {fmtNum(vendorAdj)} adj kits
                            </span>
                          )}
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell className="text-right">
                    {(() => {
                      const left = Number(b.freight_demand_usd) - Number(b.freight_paid_usd);
                      return (
                        <span className={left === 0 ? 'text-emerald-300' : left < 0 ? 'text-amber-300 font-medium' : ''}>
                          {left < 0 ? `over by ${fmtUSD(-left)}` : fmtUSD(left)}
                          <span className="block text-[10px] text-muted-foreground font-normal">{fmtUSD(b.freight_paid_usd)}/{fmtUSD(b.freight_demand_usd)} paid</span>
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell><StatusPill value={b.pay_status} /></TableCell>
                </TableRow>
                {withLines && productProgress.filter(pp => pp.vendor_code === b.vendor_code).map(pp => {
                  const left = Number(pp.kits_demand) - Number(pp.kits_paid);
                  const adj = Number(pp.adj_kits);
                  return (
                    <TableRow key={`pp-${pp.group_buy_product_id}`} className="bg-muted/30 hover:bg-muted/40">
                      <TableCell className="pl-8 text-sm text-muted-foreground">
                        ↳ {pp.sku_code}
                        {/* every admin adjustment that ADDS TO (or removes
                            from) the purchase numbers gets a labeled chip —
                            the demand cell on the right shows the same split
                            as orders + adj */}
                        {adj !== 0 && (pp.adj_detail || []).map(d => (
                          <span key={d.kind}
                            className={`ml-1.5 rounded text-[10px] font-semibold px-1.5 py-0.5 whitespace-nowrap ${adjChipClass(d.kind)}`}
                            title={`${fmtNum(Math.abs(Number(d.qty)))} ${Number(d.qty) < 0 ? 'kits removed from' : 'kits added to'} the vendor order by ${d.kind} adjustments — included in this product's demand`}>
                            {Number(d.qty) < 0 ? '−' : '+'}{fmtNum(Math.abs(Number(d.qty)))} {d.kind}
                          </span>
                        ))}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {fmtUSD(pp.vendor_order_value_usd, { cents: false })}
                        {(() => {
                          const remKits = Math.max(Number(pp.kits_demand) - Number(pp.kits_paid), 0);
                          const remUsd = Math.round(remKits * Number(pp.per_kit_cost_usd) * 100) / 100;
                          return remUsd > 0 ? (
                            <span className="block text-[10px] text-violet-300 whitespace-nowrap"
                              title={`${fmtNum(remKits)} kits still to buy × ${fmtUSD(pp.per_kit_cost_usd)}/kit`}>
                              left to buy {fmtUSD(remUsd)}
                            </span>
                          ) : null;
                        })()}
                      </TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell className="text-right text-sm">
                        <span className={left === 0 ? 'text-emerald-300' : left < 0 ? 'text-amber-300 font-medium' : ''}>
                          {left < 0 ? `over by ${fmtNum(-left)}` : fmtNum(left)}
                          <span className="block text-[10px] text-muted-foreground font-normal">{fmtNum(pp.kits_paid)}/{fmtNum(pp.kits_demand)} paid</span>
                          {adj !== 0 && (
                            <span className="block text-[10px] text-indigo-700 font-normal whitespace-nowrap"
                              title="The purchase total is customer orders plus admin adjustments (rounded up to whole kits)">
                              = {fmtNum(pp.orders_kits)} orders {adj < 0 ? '−' : '+'} {fmtNum(Math.abs(adj))} adj
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell />
                      <TableCell />
                    </TableRow>
                  );
                })}
                </React.Fragment>
              );
              return (
                <>
                  {productBalances.map(b => vendorRows(b, true))}
                  {coaBalances.length > 0 && (
                    <TableRow className="bg-muted/50 hover:bg-muted/50">
                      <TableCell colSpan={7} className="py-1.5">
                        <span className="flex items-center gap-3 text-xs font-semibold uppercase text-muted-foreground">
                          COA vendors
                          <span className="flex items-center gap-1.5 font-normal normal-case">
                            <Switch checked={showCoaLines} onCheckedChange={setShowCoaLines} className="scale-75" />
                            show product lines
                          </span>
                        </span>
                      </TableCell>
                    </TableRow>
                  )}
                  {coaBalances.map(b => vendorRows(b, showCoaLines))}
                </>
              );
            })()}
            {balances.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-6">No campaign products yet — vendor balances appear once products are configured.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Record vendor payment</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {/* persistent labels (form-UX sweep 2026-09-12) */}
            <div className="grid gap-3 grid-cols-2">
              <Field label="Vendor">
                <Select value={pVendor} disabled={pSaving} onValueChange={v => { setPVendor(v); setPLines([blankLine()]); }}>
                  <SelectTrigger className="h-9 w-full"><SelectValue placeholder="Pick…" /></SelectTrigger>
                  <SelectContent>
                    {vendors.filter(v => v.active).map(v => <SelectItem key={v.id} value={String(v.id)}>{v.code}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Payment date">
                <Input type="date" value={pDate} disabled={pSaving} onChange={e => setPDate(e.target.value)} className="h-9 w-full" />
              </Field>
            </div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Product lines · kits paid for</p>
            {pLines.map((l, i) => (
              <div key={i} className="flex flex-wrap gap-2 items-center">
                <Select value={l.product} disabled={pSaving} onValueChange={v => setLine(i, { product: v })}>
                  <SelectTrigger className="h-9 flex-1 min-w-40"><SelectValue placeholder={pVendor ? 'Product' : 'Pick a vendor first'} /></SelectTrigger>
                  <SelectContent>
                    {vendorProducts.map(pp => (
                      <SelectItem key={pp.group_buy_product_id} value={String(pp.group_buy_product_id)}>
                        {pp.sku_code} ({fmtNum(Number(pp.kits_demand) - Number(pp.kits_paid))} left @ {fmtUSD(pp.per_kit_cost_usd)})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input placeholder="Kits" inputMode="decimal" value={l.kits} disabled={pSaving} onChange={e => setLine(i, { kits: e.target.value })} className="h-9 w-20" />
                <Input placeholder="Value $" inputMode="decimal" value={l.value} disabled={pSaving} onChange={e => setLine(i, { value: e.target.value, valueDirty: e.target.value.trim() !== '' })} className="h-9 w-28" />
                {pLines.length > 1 && (
                  <Button size="sm" variant="ghost" className="h-9 px-2 text-rose-400" disabled={pSaving} onClick={() => setPLines(ls => ls.filter((_, j) => j !== i))}>✕</Button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-2 items-center">
              <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!pVendor || pSaving}
                onClick={() => setPLines(ls => [...ls, blankLine()])}>
                + Add product line
              </Button>
              <Field label="Freight $ · optional" className="w-40">
                <Input inputMode="decimal" value={pFreight} disabled={pSaving} onChange={e => setPFreight(e.target.value)} className="h-9 w-full" />
              </Field>
            </div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Sends · wallet · amount · token · tx ref</p>
            {pSends.map((s, i) => (
              <div key={i} className="flex flex-wrap gap-2 items-center">
                <Select value={s.wallet} disabled={pSaving} onValueChange={v => setSend(i, { wallet: v })}>
                  <SelectTrigger className="h-9 w-36"><SelectValue placeholder="Wallet" /></SelectTrigger>
                  <SelectContent>
                    {wallets.filter(w => w.active).map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input placeholder="Amount $" inputMode="decimal" value={sendAmount(i)} disabled={pSaving}
                  title={s.amountDirty ? 'Typed amount — clear it to auto-fill the remainder' : 'Auto-fills with what the other sends leave of the total'}
                  onChange={e => setSend(i, { amount: e.target.value, amountDirty: e.target.value.trim() !== '' })} className="h-9 w-28" />
                <Input placeholder="USDC" value={s.method} disabled={pSaving} onChange={e => setSend(i, { method: e.target.value })} className="h-9 w-20" />
                <Input placeholder="Tx hash / receipt · optional" value={s.ref} disabled={pSaving} onChange={e => setSend(i, { ref: e.target.value })} className="h-9 flex-1 min-w-40" />
                {pSends.length > 1 && (
                  <Button size="sm" variant="ghost" className="h-9 px-2 text-rose-400" disabled={pSaving} onClick={() => setPSends(ss => ss.filter((_, j) => j !== i))}>✕</Button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-2 items-end">
              <Button size="sm" variant="outline" className="h-8 text-xs" disabled={pSaving}
                title="The same payment sent on another rail — e.g. part on SOL, the rest on ETH"
                onClick={() => setPSends(ss => [...ss, blankSend()])}>
                + Add send (another rail)
              </Button>
              <Field label="Note · optional" className="flex-1 min-w-40">
                <Input value={pNote} disabled={pSaving} onChange={e => setPNote(e.target.value)} className="h-9 w-full" />
              </Field>
            </div>
            {pError && <p className="text-sm text-rose-400">{pError}</p>}
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm font-semibold">
                Total: {fmtUSD(paymentTotal)}
                {paymentTotal > 0 && (
                  <span className={`block text-[10px] font-normal ${sendsMatch ? 'text-emerald-300' : 'text-rose-400'}`}>
                    {sendsMatch ? `sends cover it (${pSends.filter((_, i) => Number(sendAmount(i)) > 0).length} send${pSends.filter((_, i) => Number(sendAmount(i)) > 0).length === 1 ? '' : 's'})` : `sends total ${fmtUSD(sendsTotal)} — must equal the total`}
                  </span>
                )}
              </span>
              <Button size="sm" onClick={recordPayment} disabled={pSaving || paymentTotal <= 0 || !sendsMatch}>Record payment</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Add vendor</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Field label="Vendor code" className="flex-1">
                <Input placeholder="e.g. MEDUSA" value={nvCode} onChange={e => setNvCode(e.target.value)} className="h-9 w-full" />
              </Field>
              <Button size="sm" className="h-9 self-end" onClick={addNewVendor}>Add</Button>
            </div>
            {nvError && <p className="text-sm text-rose-400">{nvError}</p>}
            <p className="text-xs text-muted-foreground">Existing: {vendors.map(v => v.code).join(', ')}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Payment log</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Vendor</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Kits</TableHead>
                <TableHead className="text-right">Freight</TableHead>
                <TableHead>Wallet</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Note</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p, i) => {
                // a batched payment's lines arrive contiguous (the loader
                // orders by batch): its FIRST line gets a header row above
                // it carrying the batch total, its sends (one per rail) and
                // the one Remove that takes the whole batch
                const batched = p.batch_id != null;
                const firstOfBatch = batched && (i === 0 || payments[i - 1].batch_id !== p.batch_id);
                const batchLines = batched ? payments.filter(q => q.batch_id === p.batch_id) : [];
                const batchTotal = batchLines.reduce((s, q) => s + Number(q.amount_usd), 0);
                return (
                  <React.Fragment key={p.id}>
                    {firstOfBatch && (
                      <TableRow className="bg-muted/30 hover:bg-muted/40">
                        <TableCell>{fmtDate(p.paid_on)}</TableCell>
                        <TableCell className="font-medium">{p.vendor_code}</TableCell>
                        <TableCell className="text-right font-medium">{fmtUSD(batchTotal)}</TableCell>
                        <TableCell colSpan={6} className="text-xs">
                          <span className="text-muted-foreground mr-1">{batchLines.length} line{batchLines.length === 1 ? '' : 's'} · sent as</span>
                          {(p.sends || []).map(s => (
                            <span key={s.id} className="inline-flex items-center gap-1 rounded bg-slate-400/10 px-1.5 py-0.5 mr-1.5 whitespace-nowrap"
                              title={s.tx_ref ? `${s.wallet_name} (${s.chain}) · ${s.method || '—'} · ${fmtUSD(s.amount_usd)} · ${s.tx_ref}` : `${s.wallet_name} (${s.chain}) · ${s.method || '—'} · ${fmtUSD(s.amount_usd)}`}>
                              <span className="font-medium">{s.wallet_name}</span> · {s.method || '—'} · {fmtUSD(s.amount_usd)}
                              {s.tx_ref && <span className="text-muted-foreground font-mono">· {s.tx_ref.length > 14 ? s.tx_ref.slice(0, 14) + '…' : s.tx_ref}</span>}
                            </span>
                          ))}
                          {p.note && <span className="block text-muted-foreground mt-0.5">{p.note}</span>}
                        </TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-400"
                            onClick={async () => {
                              // Deleting a payment moves real balances — the
                              // whole batch goes (every line and every send).
                              const lineText = batchLines.map(q => `  ${q.sku_code || 'freight'} — ${fmtUSD(q.amount_usd)}${q.kits_qty != null ? ` (${fmtNum(q.kits_qty)} kits)` : ''}`).join('\n');
                              const sendText = (p.sends || []).map(s => `  ${s.wallet_name} — ${fmtUSD(s.amount_usd)}${s.method ? ` ${s.method}` : ''}`).join('\n');
                              if (!window.confirm(`Remove this vendor payment batch?\n\n${p.vendor_code} — ${fmtUSD(batchTotal)} on ${fmtDate(p.paid_on)}\n\nLines:\n${lineText}\n\nSends:\n${sendText}\n\nEvery line and send is preserved in the audit log for reconstruction.`)) return;
                              const res = await doDeleteBatch({ batch_id: p.batch_id, group_buy_id: groupBuyId, actor: userName }) as unknown[] | null;
                              const wrote = Array.isArray(res) ? res.length > 0 : !!res;
                              if (!wrote) { setPError('Batch not removed — it may belong to a different campaign or was already deleted.'); return; }
                              reloadBalances(); reloadPayments(); reloadProgress();
                            }}>
                            Remove batch
                          </Button>
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell className={batched ? 'pl-6 text-muted-foreground' : ''}>{batched ? '↳' : fmtDate(p.paid_on)}</TableCell>
                      <TableCell className={batched ? 'text-muted-foreground' : 'font-medium'}>{p.vendor_code}</TableCell>
                      <TableCell className="text-right">{fmtUSD(p.amount_usd)}</TableCell>
                      <TableCell>{p.sku_code || (p.freight_usd != null ? 'freight' : '—')}</TableCell>
                      <TableCell className="text-right">{p.kits_qty != null ? fmtNum(p.kits_qty) : '—'}</TableCell>
                      <TableCell className="text-right">{p.freight_usd != null ? fmtUSD(p.freight_usd) : '—'}</TableCell>
                      <TableCell className="text-muted-foreground">{batched ? 'see sends' : (p.wallet_name || '—')}</TableCell>
                      <TableCell>{batched ? '' : (p.method || '—')}</TableCell>
                      <TableCell className="text-muted-foreground">{batched ? '' : (p.note || '')}</TableCell>
                      <TableCell>
                        {!batched && (
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-400"
                            onClick={async () => {
                              // Deleting a payment moves real balances — make the
                              // operator confirm exactly which one they're removing.
                              if (!window.confirm(`Remove this vendor payment?\n\n${p.vendor_code} — ${fmtUSD(p.amount_usd)} on ${fmtDate(p.paid_on)}${p.sku_code ? ` (${p.sku_code})` : ''}\n\nThe full payment is preserved in the audit log for reconstruction.`)) return;
                              const res = await doDeletePayment({ id: p.id, group_buy_id: groupBuyId, actor: userName }) as unknown[] | null;
                              const wrote = Array.isArray(res) ? res.length > 0 : !!res;
                              if (!wrote) { setPError('Payment not removed — it may belong to a different campaign or was already deleted.'); return; }
                              reloadBalances(); reloadPayments(); reloadProgress();
                            }}>
                            Remove
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  </React.Fragment>
                );
              })}
              {payments.length === 0 && (
                <TableRow><TableCell colSpan={10} className="text-center text-muted-foreground py-6">No vendor payments yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
