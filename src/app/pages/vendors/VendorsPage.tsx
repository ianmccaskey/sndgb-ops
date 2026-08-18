import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listVendors from '@/actions/vendors/listVendors';
import listVendorBalances from '@/actions/vendors/listVendorBalances';
import listVendorPayments from '@/actions/vendors/listVendorPayments';
import listVendorProductProgress from '@/actions/vendors/listVendorProductProgress';
import addVendorPayment from '@/actions/vendors/addVendorPayment';
import deleteVendorPayment from '@/actions/vendors/deleteVendorPayment';
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

type Vendor = { id: number; code: string; name: string; active: boolean };
type Balance = {
  vendor_id: number; vendor_code: string; owed_usd: string; paid_usd: string;
  balance_usd: string; pay_status: string;
  product_owed_usd: string; freight_demand_usd: string; kits_demand: string;
  kits_paid: string; freight_paid_usd: string;
};
type Payment = {
  id: number; paid_on: string; amount_usd: string; method: string | null;
  receipt_ref: string | null; note: string | null; vendor_code: string; wallet_name: string | null;
  kits_qty: string | null; freight_usd: string | null; sku_code: string | null;
};
type Wallet = { id: number; name: string };
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
  [/^stock plan$/, 'bg-emerald-100 text-emerald-900'],
  [/^outside sale$/, 'bg-sky-100 text-sky-900'],
  [/^personal/, 'bg-indigo-100 text-indigo-900'],
  [/^admin$/, 'bg-zinc-200 text-zinc-800'],
];
const adjChipClass = (kind: string) =>
  (ADJ_CHIP_STYLES.find(([re]) => re.test(kind)) || [null, 'bg-zinc-200 text-zinc-800'])[1];

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

  const [doPay] = useMutateAction(addVendorPayment);
  const [doSaveVendor] = useMutateAction(saveVendor);
  const [doDeletePayment] = useMutateAction(deleteVendorPayment);

  const [pVendor, setPVendor] = useState('');
  const [pDate, setPDate] = useState('');
  const [pWallet, setPWallet] = useState('');
  const [pMethod, setPMethod] = useState('USDC');
  const [pRef, setPRef] = useState('');
  const [pNote, setPNote] = useState('');
  // one payment = one or more product lines; each line's value auto-computes
  // from kits × the product's current per-kit vendor cost, editable for
  // discounts. Every line is recorded as its own guarded payment row.
  type PayLine = { product: string; kits: string; value: string; valueDirty: boolean };
  const [pLines, setPLines] = useState<PayLine[]>([{ product: '', kits: '', value: '', valueDirty: false }]);
  const [pFreight, setPFreight] = useState('');
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
    const failed: string[] = [];
    const recordedLines = new Set<PayLine>();
    let freightRecorded = false;
    try {
      // each line is its own guarded payment row (single-row inserts are a
      // platform requirement); shared date/wallet/method/receipt/note tie
      // them together in the log
      for (const l of active) {
        const sku = vendorProducts.find(v => String(v.group_buy_product_id) === l.product)?.sku_code || '?';
        const res = await doPay({
          vendor_id: Number(pVendor), group_buy_id: groupBuyId, paid_on: pDate,
          amount_usd: Number(l.value), wallet_id: pWallet, method: pMethod, receipt_ref: pRef, note: pNote,
          kits_qty: l.kits.trim(), freight_usd: '', group_buy_product_id: l.product,
          allow_over: overLines.has(l) ? 'true' : '',
          confirmed_owed: overLines.has(l) ? String(kitsOwed(l) ?? '') : '',
          allow_over_freight: '', confirmed_freight_owed: '',
          actor: userName,
        }) as unknown[] | null;
        const wrote = Array.isArray(res) ? res.length > 0 : !!res;
        if (wrote) recordedLines.add(l);
        // only reachable when this page's owed figures were stale (someone
        // else recorded meanwhile) — the reload below refreshes them, so
        // pressing Record again raises the override confirmation
        else failed.push(sku + ' (refused — exceeds kits still owed; press Record again to confirm the over-buy)');
      }
      if (Number(pFreight) > 0) {
        const res = await doPay({
          vendor_id: Number(pVendor), group_buy_id: groupBuyId, paid_on: pDate,
          amount_usd: Number(pFreight), wallet_id: pWallet, method: pMethod, receipt_ref: pRef,
          note: (pNote ? pNote + ' | ' : '') + 'freight',
          kits_qty: '', freight_usd: pFreight.trim(), group_buy_product_id: '',
          allow_over: '', confirmed_owed: '',
          allow_over_freight: freightOver ? 'true' : '',
          confirmed_freight_owed: freightOver ? String(freightOwed ?? '') : '',
          actor: userName,
        }) as unknown[] | null;
        const wrote = Array.isArray(res) ? res.length > 0 : !!res;
        if (wrote) freightRecorded = true;
        else failed.push('freight (refused — exceeds freight still owed, or the ledger moved while confirming; press Record again to confirm the override)');
      }
      if (failed.length > 0) {
        setPError('Some lines were NOT recorded: ' + failed.join('; ') + '. Recorded lines moved to the log below; the form now holds only what is still unrecorded.');
      } else {
        setPRef(''); setPNote('');
      }
    } catch (e: unknown) {
      setPError((e instanceof Error ? e.message : 'Failed to record payment') + ' — recorded lines moved to the log; the form keeps only what is still unrecorded.');
    } finally {
      // Runs on success, refusal, AND thrown errors alike: the form must
      // always end up holding EXACTLY the unrecorded subset, so a retry can
      // never duplicate a row that already landed (recorded lines are in
      // the log with their audited Remove path).
      setPLines(ls => {
        const remaining = ls.filter(l => !recordedLines.has(l) && (l.product || l.kits.trim() || l.value.trim()));
        return remaining.length > 0 ? remaining : [{ product: '', kits: '', value: '', valueDirty: false }];
      });
      if (freightRecorded) setPFreight('');
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
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Store className="h-6 w-6 text-violet-600" /> Vendors
        </h1>
        <p className="text-sm text-muted-foreground mt-1">Balances are computed from final counts × unit cost; payments are logged, never typed over.</p>
      </div>

      {overpaid.length > 0 && (
        <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 flex items-center gap-2">
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
                  <TableCell className={`text-right font-medium ${parseFloat(b.balance_usd) < 0 ? 'text-red-600' : ''}`}>
                    {fmtUSD(b.balance_usd)}
                    {(() => {
                      const rem = remainingProductUsd(b.vendor_code);
                      // only shown when it differs from the netted balance —
                      // that difference is exactly the over-payments hiding
                      // inside the aggregate (plus freight, tracked in its
                      // own column)
                      return rem > 0 ? (
                        <span className="block text-[10px] text-violet-700 font-normal whitespace-nowrap"
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
                        <span className={left === 0 ? 'text-green-700' : left < 0 ? 'text-amber-600 font-medium' : ''}>
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
                        <span className={left === 0 ? 'text-green-700' : left < 0 ? 'text-amber-600 font-medium' : ''}>
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
                            <span className="block text-[10px] text-violet-700 whitespace-nowrap"
                              title={`${fmtNum(remKits)} kits still to buy × ${fmtUSD(pp.per_kit_cost_usd)}/kit`}>
                              left to buy {fmtUSD(remUsd)}
                            </span>
                          ) : null;
                        })()}
                      </TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell className="text-right text-sm">
                        <span className={left === 0 ? 'text-green-700' : left < 0 ? 'text-amber-600 font-medium' : ''}>
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
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Select value={pVendor} disabled={pSaving} onValueChange={v => { setPVendor(v); setPLines([{ product: '', kits: '', value: '', valueDirty: false }]); }}>
                <SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Vendor" /></SelectTrigger>
                <SelectContent>
                  {vendors.filter(v => v.active).map(v => <SelectItem key={v.id} value={String(v.id)}>{v.code}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input type="date" value={pDate} disabled={pSaving} onChange={e => setPDate(e.target.value)} className="h-9 w-40" />
            </div>
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
                <Input placeholder="Kits" value={l.kits} disabled={pSaving} onChange={e => setLine(i, { kits: e.target.value })} className="h-9 w-20" />
                <Input placeholder="Value $" value={l.value} disabled={pSaving} onChange={e => setLine(i, { value: e.target.value, valueDirty: e.target.value.trim() !== '' })} className="h-9 w-28" />
                {pLines.length > 1 && (
                  <Button size="sm" variant="ghost" className="h-9 px-2 text-red-600" disabled={pSaving} onClick={() => setPLines(ls => ls.filter((_, j) => j !== i))}>✕</Button>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-2 items-center">
              <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!pVendor || pSaving}
                onClick={() => setPLines(ls => [...ls, { product: '', kits: '', value: '', valueDirty: false }])}>
                + Add product line
              </Button>
              <Input placeholder="Freight $ (optional)" value={pFreight} disabled={pSaving} onChange={e => setPFreight(e.target.value)} className="h-8 w-40" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={pWallet} disabled={pSaving} onValueChange={setPWallet}>
                <SelectTrigger className="h-9 flex-1"><SelectValue placeholder="Paid from wallet" /></SelectTrigger>
                <SelectContent>
                  {wallets.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Input placeholder="Method" value={pMethod} disabled={pSaving} onChange={e => setPMethod(e.target.value)} className="h-9 w-24" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Input placeholder="Receipt / tx ref (optional)" value={pRef} disabled={pSaving} onChange={e => setPRef(e.target.value)} className="h-9 flex-1" />
              <Input placeholder="Note" value={pNote} disabled={pSaving} onChange={e => setPNote(e.target.value)} className="h-9 flex-1" />
            </div>
            {pError && <p className="text-sm text-red-600">{pError}</p>}
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">Total: {fmtUSD(paymentTotal)}</span>
              <Button size="sm" onClick={recordPayment} disabled={pSaving || paymentTotal <= 0}>Record payment</Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Add vendor</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Input placeholder="Vendor code (e.g. MEDUSA)" value={nvCode} onChange={e => setNvCode(e.target.value)} className="h-9 flex-1" />
              <Button size="sm" onClick={addNewVendor}>Add</Button>
            </div>
            {nvError && <p className="text-sm text-red-600">{nvError}</p>}
            <p className="text-xs text-muted-foreground">Existing: {vendors.map(v => v.code).join(', ')}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Payment log</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
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
              {payments.map(p => (
                <TableRow key={p.id}>
                  <TableCell>{fmtDate(p.paid_on)}</TableCell>
                  <TableCell className="font-medium">{p.vendor_code}</TableCell>
                  <TableCell className="text-right">{fmtUSD(p.amount_usd)}</TableCell>
                  <TableCell>{p.sku_code || '—'}</TableCell>
                  <TableCell className="text-right">{p.kits_qty != null ? fmtNum(p.kits_qty) : '—'}</TableCell>
                  <TableCell className="text-right">{p.freight_usd != null ? fmtUSD(p.freight_usd) : '—'}</TableCell>
                  <TableCell>{p.wallet_name || '—'}</TableCell>
                  <TableCell>{p.method || '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{p.note || ''}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600"
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
                  </TableCell>
                </TableRow>
              ))}
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
