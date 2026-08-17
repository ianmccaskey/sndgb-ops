import React, { useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listProducts from '@/actions/products/listProducts';
import saveProduct from '@/actions/products/saveProduct';
import listVendors from '@/actions/vendors/listVendors';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import upsertCampaignProduct from '@/actions/campaign/upsertCampaignProduct';
import markOrderedFromVendor from '@/actions/campaign/markOrderedFromVendor';
import listAdjustments from '@/actions/campaign/listAdjustments';
import addAdjustment from '@/actions/campaign/addAdjustment';
import deleteAdjustment from '@/actions/campaign/deleteAdjustment';
import markAdjustmentReceived from '@/actions/campaign/markAdjustmentReceived';
import getPnl from '@/actions/financials/getPnl';
import { useApp } from '@/app/AppContext';
import { OrderingAppSync } from '@/app/pages/products/OrderingAppSync';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD, fmtNum, fmtDate, fmtDateTime } from '@/lib/fmt';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Package, CheckCircle2 } from 'lucide-react';

type Product = { id: number; external_id: string | null; sku_code: string; name: string; mass_label: string | null; active: boolean };
type Vendor = { id: number; code: string; active: boolean };
type CampaignProduct = {
  group_buy_product_id: number; sku_code: string; product_name: string; vendor_code: string;
  unit_cost_usd: string; margin_usd: string; gb_price_usd: string; target_moq: string;
  demand_qty: string; adjustment_qty: string; final_count: string; moq_met: boolean;
  testing_cost_usd: string; freight_usd: string; net_profit_per_unit_usd: string;
  total_product_profit_usd: string; owed_to_vendor_usd: string; expected_revenue_usd: string;
  ordered_from_vendor_at: string | null;
  qty_cap: string | null;
  cost_tier_qty: string | null; cost_tier_price: string | null;
  direct_freight_usd: string; direct_box_kits: string; split_fee_usd: string;
};
type Adjustment = {
  id: number; sku_code: string; qty: string; reason: string; created_by: string; created_at: string; beneficiary: string; value_usd: string;
  pricing: string; expected_usd: string | null; received_at: string | null;
};
type SplitParty = { party: string; pct: string };

export function ProductsPage() {
  const { groupBuyId, userName } = useApp();
  const enabled = groupBuyId != null;

  const [rawProducts, , , reloadProducts] = useLoadAction(listProducts, [], {});
  const [rawVendors] = useLoadAction(listVendors, [], {});
  const [rawCampaign, , , reloadCampaign] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawAdj, , , reloadAdj] = useLoadAction(listAdjustments, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawPnl] = useLoadAction(getPnl, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const splitParties: SplitParty[] = (firstRow<{ splits: SplitParty[] | null }>(rawPnl)?.splits) || [];

  const products = rows<Product>(rawProducts);
  const vendors = rows<Vendor>(rawVendors);
  const campaign = rows<CampaignProduct>(rawCampaign);
  const adjustments = rows<Adjustment>(rawAdj);

  const [doSaveProduct] = useMutateAction(saveProduct);
  const [doUpsertCampaign] = useMutateAction(upsertCampaignProduct);
  const [doMarkOrdered] = useMutateAction(markOrderedFromVendor);
  const [doAddAdj] = useMutateAction(addAdjustment);
  const [doDelAdj] = useMutateAction(deleteAdjustment);
  const [doMarkReceived] = useMutateAction(markAdjustmentReceived);

  // add-to-campaign form
  const [cProduct, setCProduct] = useState('');
  const [cVendor, setCVendor] = useState('');
  const [cCost, setCCost] = useState('');
  const [cPrice, setCPrice] = useState('');
  const [cMoq, setCMoq] = useState('');
  const [cTesting, setCTesting] = useState('225');
  const [cFreight, setCFreight] = useState('0');
  const [cDirectFreight, setCDirectFreight] = useState('0'); // $ per box, direct-ship lines only
  const [cDirectBox, setCDirectBox] = useState('30'); // kits per box
  const [cSplitFee, setCSplitFee] = useState('0'); // $ per split (half) kit line
  const [cCap, setCCap] = useState(''); // optional max available; '' = uncapped
  const [cTierPrice, setCTierPrice] = useState(''); // optional tiered cost: $ per N units
  const [cTierQty, setCTierQty] = useState('');
  const [cEditing, setCEditing] = useState<number | null>(null); // group_buy_product_id being edited
  const [cError, setCError] = useState('');

  // new product form
  const [npSku, setNpSku] = useState('');
  const [npName, setNpName] = useState('');
  const [npMass, setNpMass] = useState('');
  const [npError, setNpError] = useState('');

  // adjustment form
  const [aProduct, setAProduct] = useState('');
  const [aQty, setAQty] = useState('');
  const [aReason, setAReason] = useState('');
  const [aFor, setAFor] = useState('both');
  const [aPricing, setAPricing] = useState('gb'); // 'gb' | 'cost' (at-cost outside-GB sale)
  const [aError, setAError] = useState('');

  const saveCampaignProduct = async () => {
    const price = Number(cPrice);
    const tierQtyFilled = cTierQty.trim() !== '';
    const tierPriceFilled = cTierPrice.trim() !== '';
    if (tierQtyFilled !== tierPriceFilled) {
      setCError('Cost tier needs BOTH the tier price and the "per N units" — fill both, or clear both.');
      return;
    }
    const tiered = tierQtyFilled && tierPriceFilled && Number(cTierQty) > 0 && Number(cTierPrice) >= 0;
    if ((tierQtyFilled || tierPriceFilled) && !tiered) {
      setCError('Cost tier values are invalid — price ≥ 0 and units > 0.');
      return;
    }
    const cost = Number(cCost);
    if (!cProduct || !cVendor || !(price >= 0) || !(Number(cMoq) >= 0)) {
      setCError('Product, vendor, GB price, and MOQ are required.');
      return;
    }
    // DB stores margin (GB price = unit_cost + margin, generated). For a flat
    // line derive margin from the entered price; for a tiered line the real
    // cost lives in cost_tier_*, so unit_cost is 0 and margin carries the price.
    let unitCost: number, margin: number;
    if (tiered) {
      unitCost = 0;
      margin = price;
    } else {
      if (cCost.trim() === '' || !(cost >= 0)) { setCError('Enter a unit cost, or a cost tier ($ per N units).'); return; }
      unitCost = cost;
      margin = +(price - cost).toFixed(2);
      if (margin < 0) { setCError(`GB price ($${price}) can't be below your unit cost ($${cost}).`); return; }
    }
    setCError('');
    try {
      const res = await doUpsertCampaign({
        group_buy_id: groupBuyId, product_id: Number(cProduct), vendor_id: Number(cVendor),
        unit_cost_usd: unitCost, margin_usd: margin, target_moq: Number(cMoq),
        testing_cost_usd: Number(cTesting || 0), freight_usd: Number(cFreight || 0),
        direct_freight_usd: cDirectFreight.trim(), direct_box_kits: cDirectBox.trim(),
        split_fee_usd: cSplitFee.trim(),
        qty_cap: cCap.trim(),
        cost_tier_qty: tiered ? cTierQty.trim() : '',
        cost_tier_price: tiered ? cTierPrice.trim() : '',
      }) as unknown[] | null;
      // Zero rows = the vendor-change guard refused (kit payments are already
      // attributed to this product under its current vendor).
      const wrote = Array.isArray(res) ? res.length > 0 : !!res;
      if (!wrote) {
        setCError('Not saved — this product already has vendor payments recorded against it, so its vendor cannot be changed. Remove/reassign those payments on the Vendors page first.');
        return;
      }
      resetCampaignForm();
      reloadCampaign();
    } catch (e: unknown) {
      setCError(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const resetCampaignForm = () => {
    setCEditing(null);
    setCProduct(''); setCVendor(''); setCCost(''); setCPrice(''); setCMoq('');
    setCTesting('225'); setCFreight('0'); setCDirectFreight('0'); setCDirectBox('30'); setCSplitFee('0');
    setCCap(''); setCTierPrice(''); setCTierQty('');
    setCError('');
  };

  // Load an existing campaign line into the form for editing. product_id and
  // vendor_id aren't in the profit view, so resolve them from the loaded lists.
  const editCampaignProduct = (c: CampaignProduct) => {
    const prod = products.find(p => p.sku_code === c.sku_code);
    const vend = vendors.find(v => v.code === c.vendor_code);
    setCEditing(c.group_buy_product_id);
    setCProduct(prod ? String(prod.id) : '');
    setCVendor(vend ? String(vend.id) : '');
    // A tiered row stores unit_cost 0 as a placeholder (real cost is the tier).
    // Don't prefill that 0 — if the editor clears the tier to go flat, the empty
    // box forces a real unit cost instead of silently saving $0.
    setCCost(c.cost_tier_price != null ? '' : String(Number(c.unit_cost_usd)));
    setCPrice(String(Number(c.gb_price_usd)));
    setCMoq(String(Number(c.target_moq)));
    setCTesting(String(Number(c.testing_cost_usd)));
    setCFreight(String(Number(c.freight_usd)));
    setCDirectFreight(String(Number(c.direct_freight_usd)));
    setCDirectBox(String(Number(c.direct_box_kits)));
    setCSplitFee(String(Number(c.split_fee_usd)));
    setCCap(c.qty_cap == null ? '' : String(Number(c.qty_cap)));
    setCTierQty(c.cost_tier_qty == null ? '' : String(Number(c.cost_tier_qty)));
    setCTierPrice(c.cost_tier_price == null ? '' : String(Number(c.cost_tier_price)));
    setCError('');
  };

  const addProduct = async () => {
    if (!npSku.trim() || !npName.trim()) { setNpError('SKU and name required.'); return; }
    setNpError('');
    try {
      await doSaveProduct({ sku_code: npSku.trim(), name: npName.trim(), mass_label: npMass.trim(), external_id: '', active: true });
      setNpSku(''); setNpName(''); setNpMass('');
      reloadProducts();
    } catch (e: unknown) {
      setNpError(e instanceof Error ? e.message : 'Failed to add product');
    }
  };

  // at-cost preview: what the outside customer owes (cost + freight per kit)
  const aCostProduct = campaign.find(c => String(c.group_buy_product_id) === aProduct);
  const aExpectedUsd = aPricing === 'cost' && aCostProduct && Number(aQty) > 0
    ? Math.round(Number(aQty) * (Number(aCostProduct.unit_cost_usd) + Number(aCostProduct.freight_usd)) * 100) / 100
    : null;

  const addAdj = async () => {
    const qty = Number(aQty);
    if (!aProduct || !qty || !aReason.trim()) {
      setAError('Product, non-zero qty, and reason are all required — adjustments are audited.');
      return;
    }
    // Same scale rule as order items (NUMERIC(10,2)): validate on the typed
    // string, not float math, so 1.15 stays valid and 0.333 is refused.
    if (!/^-?\d+(?:\.\d{1,2})?$/.test(aQty.trim())) {
      setAError('Qty must have at most 2 decimal places (split kits use 0.5).');
      return;
    }
    if (aPricing === 'cost') {
      if (!(qty > 0) || qty % 1 !== 0) { setAError('An at-cost sale needs a positive WHOLE-kit qty (fractional kits would break the P&L-neutral math).'); return; }
      if (aCostProduct?.cost_tier_price != null) {
        setAError('At-cost sales are not supported on tiered-cost products — their incremental vendor cost is not qty × unit cost.');
        return;
      }
    }
    setAError('');
    try {
      // The action refuses (returns no row) instead of letting Postgres
      // round an over-precision qty — surface that as an error, not success.
      const res = await doAddAdj({
        group_buy_product_id: Number(aProduct), qty, reason: aReason.trim(), created_by: userName,
        beneficiary: aFor, pricing: aPricing,
      });
      // Mutate results can be an array of rows or a singleton object — treat
      // only an empty/absent result as refused (same handling as ImportPage).
      const wrote = Array.isArray(res) ? res.length > 0 : !!res;
      if (!wrote) throw new Error('Adjustment refused: check qty (non-zero, max 2 decimals; positive and non-tiered product for at-cost).');
      setAQty(''); setAReason(''); setAFor('both'); setAPricing('gb');
      reloadAdj(); reloadCampaign();
    } catch (e: unknown) {
      setAError(e instanceof Error ? e.message : 'Failed to add adjustment');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Package className="h-6 w-6 text-violet-600" /> Products & Campaign Setup
        </h1>
        <p className="text-sm text-muted-foreground mt-1">One quantity basis everywhere: demand + adjustments = final count.</p>
      </div>

      <Tabs defaultValue="campaign">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="campaign">Campaign products</TabsTrigger>
          <TabsTrigger value="adjustments">Admin adjustments</TabsTrigger>
          <TabsTrigger value="catalog">Product catalog</TabsTrigger>
          <TabsTrigger value="sync">Ordering app</TabsTrigger>
        </TabsList>

        <TabsContent value="campaign" className="mt-4 space-y-4">
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                  <TableHead className="text-right">GB Price</TableHead>
                  <TableHead className="text-right">MOQ</TableHead>
                  <TableHead className="text-right">Demand</TableHead>
                  <TableHead className="text-right">Final</TableHead>
                  <TableHead className="text-right">Owed vendor</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Available</TableHead>
                  <TableHead>Vendor order</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaign.map(c => (
                  <TableRow key={c.group_buy_product_id}>
                    <TableCell className="font-medium">{c.sku_code}</TableCell>
                    <TableCell>{c.vendor_code}</TableCell>
                    <TableCell className="text-right">
                      {c.cost_tier_price != null
                        ? <span title="Tiered cost">{fmtUSD(c.cost_tier_price)}<span className="text-muted-foreground">/{fmtNum(c.cost_tier_qty)}</span></span>
                        : fmtUSD(c.unit_cost_usd)}
                    </TableCell>
                    <TableCell className="text-right">{c.cost_tier_price != null ? <span className="text-muted-foreground">—</span> : fmtUSD(c.margin_usd)}</TableCell>
                    <TableCell className="text-right font-medium">{fmtUSD(c.gb_price_usd)}</TableCell>
                    <TableCell className="text-right">{fmtNum(c.target_moq)}</TableCell>
                    <TableCell className={`text-right ${c.moq_met ? 'text-green-700 font-medium' : ''}`}>{fmtNum(c.demand_qty)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {fmtNum(c.final_count)}
                      {Number(c.adjustment_qty) !== 0 && (
                        <span className="block text-[10px] text-muted-foreground font-normal" title="Admin adjustments included in the final count">
                          {Number(c.adjustment_qty) > 0 ? '+' : ''}{fmtNum(c.adjustment_qty)} adj
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">{fmtUSD(c.owed_to_vendor_usd, { cents: false })}</TableCell>
                    <TableCell className="text-right text-green-700">{fmtUSD(c.total_product_profit_usd, { cents: false })}</TableCell>
                    <TableCell className="text-right text-xs">
                      {c.qty_cap == null
                        ? <span className="text-muted-foreground">—</span>
                        : Number(c.demand_qty) >= Number(c.qty_cap)
                          ? <span className="text-red-600 font-medium">SOLD OUT ({fmtNum(c.demand_qty)}/{fmtNum(c.qty_cap)})</span>
                          : <span>{fmtNum(c.demand_qty)}/{fmtNum(c.qty_cap)}</span>}
                    </TableCell>
                    <TableCell>
                      {c.ordered_from_vendor_at ? (
                        <button
                          className="text-xs text-green-700 flex items-center gap-1"
                          title={fmtDateTime(c.ordered_from_vendor_at)}
                          onClick={() => doMarkOrdered({ group_buy_product_id: c.group_buy_product_id, ordered: false }).then(reloadCampaign)}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> placed
                        </button>
                      ) : (
                        <Button
                          size="sm" variant="outline" className="h-7 text-xs"
                          onClick={() => doMarkOrdered({ group_buy_product_id: c.group_buy_product_id, ordered: true }).then(reloadCampaign)}
                        >
                          Mark placed
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => editCampaignProduct(c)}>Edit</Button>
                    </TableCell>
                  </TableRow>
                ))}
                {campaign.length === 0 && (
                  <TableRow><TableCell colSpan={13} className="text-center text-muted-foreground py-6">No products in this campaign yet — add one below.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <Card className="max-w-3xl">
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {cEditing ? 'Edit campaign product' : 'Add / update campaign product'}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Select value={cProduct} onValueChange={setCProduct} disabled={cEditing != null}>
                  <SelectTrigger className="h-9 w-48"><SelectValue placeholder="Product" /></SelectTrigger>
                  <SelectContent>
                    {products.filter(p => p.active).map(p => <SelectItem key={p.id} value={String(p.id)}>{p.sku_code}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={cVendor} onValueChange={setCVendor}>
                  <SelectTrigger className="h-9 w-40"><SelectValue placeholder="Vendor" /></SelectTrigger>
                  <SelectContent>
                    {vendors.filter(v => v.active).map(v => <SelectItem key={v.id} value={String(v.id)}>{v.code}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input placeholder="Unit cost $" value={cCost} onChange={e => setCCost(e.target.value)} disabled={cTierQty.trim() !== '' && cTierPrice.trim() !== ''} className="h-9 w-28" />
                <Input placeholder="GB price $ (to customer)" value={cPrice} onChange={e => setCPrice(e.target.value)} className="h-9 w-44" />
                <Input placeholder="Target MOQ" value={cMoq} onChange={e => setCMoq(e.target.value)} className="h-9 w-28" />
                <Input placeholder="Testing $" value={cTesting} onChange={e => setCTesting(e.target.value)} className="h-9 w-24" />
                <Input placeholder="Freight $/kit" value={cFreight} onChange={e => setCFreight(e.target.value)} className="h-9 w-24" />
                <Input placeholder="Direct freight $/box" value={cDirectFreight} onChange={e => setCDirectFreight(e.target.value)} className="h-9 w-32" title="Internal cost per box the vendor charges to ship a direct-ship line to the customer (0 = none)" />
                <Input placeholder="Box size (kits)" value={cDirectBox} onChange={e => setCDirectBox(e.target.value)} className="h-9 w-28" title="Kits per box — a 40-kit direct line in one order needs 2 boxes of 30" />
                <Input placeholder="Split fee $" value={cSplitFee} onChange={e => setCSplitFee(e.target.value)} className="h-9 w-24" title="Fee the ordering app charges a customer for a half kit (0 = halves not offered)" />
                <Input placeholder="Max available (optional)" value={cCap} onChange={e => setCCap(e.target.value)} className="h-9 w-44" />
                <Input placeholder="Cost tier $ (optional)" value={cTierPrice} onChange={e => setCTierPrice(e.target.value)} className="h-9 w-36" />
                <Input placeholder="…per N units" value={cTierQty} onChange={e => setCTierQty(e.target.value)} className="h-9 w-28" />
              </div>
              {cTierQty.trim() !== '' && cTierPrice.trim() !== '' && Number(cTierQty) > 0
                ? <p className="text-xs text-muted-foreground">Tiered vendor cost: ${Number(cTierPrice).toFixed(2)} per {cTierQty} units (unit cost ignored). GB price ${cPrice || '0'} to customer.</p>
                : (cCost !== '' && cPrice !== '' && Number(cPrice) >= Number(cCost) && (
                    <p className="text-xs text-muted-foreground">Margin per unit: ${(Number(cPrice) - Number(cCost)).toFixed(2)}</p>
                  ))}
              <p className="text-xs text-muted-foreground">Max available caps a limited item (e.g. a COA product at 25) — the Available column flags SOLD OUT at that demand. Cost tier is for stepped vendor pricing (e.g. $50 per 4 units); fill both tier fields to use it and unit cost is ignored.</p>
              {cError && <p className="text-sm text-red-600">{cError}</p>}
              <div className="flex gap-2">
                <Button size="sm" onClick={saveCampaignProduct}>{cEditing ? 'Save changes' : 'Save'}</Button>
                {cEditing && <Button size="sm" variant="ghost" onClick={resetCampaignForm}>Cancel</Button>}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="adjustments" className="mt-4 space-y-4">
          <Card className="max-w-3xl">
            <CardHeader className="pb-2"><CardTitle className="text-base">Add admin adjustment (organizer units on top of demand)</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Select value={aProduct} onValueChange={setAProduct}>
                  <SelectTrigger className="h-9 w-48"><SelectValue placeholder="Campaign product" /></SelectTrigger>
                  <SelectContent>
                    {campaign.map(c => <SelectItem key={c.group_buy_product_id} value={String(c.group_buy_product_id)}>{c.sku_code}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input placeholder="Qty (+/-)" value={aQty} onChange={e => setAQty(e.target.value)} className="h-9 w-24" />
                <Select value={aPricing} onValueChange={setAPricing}>
                  <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gb">At GB price</SelectItem>
                    <SelectItem value="cost">At vendor cost + freight</SelectItem>
                  </SelectContent>
                </Select>
                {aPricing === 'gb' && (
                  <Select value={aFor} onValueChange={setAFor}>
                    <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="both">Both</SelectItem>
                      {splitParties.map(p => <SelectItem key={p.party} value={p.party}>{p.party}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                <Input placeholder={aPricing === 'cost' ? 'Reason / customer (audited)' : "Reason (e.g. 'P&P personal x100')"} value={aReason} onChange={e => setAReason(e.target.value)} className="h-9 flex-1 min-w-48" />
                <Button size="sm" onClick={addAdj}>Add</Button>
              </div>
              {aError && <p className="text-sm text-red-600">{aError}</p>}
              {aPricing === 'gb' ? (
                <p className="text-xs text-muted-foreground">
                  "For" decides whose profit pays for these units at GB price: a person's adjustments come out of their split payout; "Both" comes out of total profit before the split.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  At-cost sale to a customer outside the group buy: the kits join what you order from the vendor, but P&L stays neutral — the customer owes vendor cost + per-kit freight
                  {aExpectedUsd != null && <> (<span className="font-medium text-foreground">{fmtUSD(aExpectedUsd)}</span> for this line)</>}, tracked until you mark it received.
                  {' '}These kits are assumed to <span className="font-medium">arrive with your bulk vendor order</span> — vendor-direct shipping to an outside customer (per-box direct freight) is not modeled here.
                </p>
              )}
            </CardContent>
          </Card>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>By</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {adjustments.map(a => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.sku_code}</TableCell>
                    <TableCell className="text-right">{fmtNum(a.qty)}</TableCell>
                    <TableCell>{a.pricing === 'cost' ? <span className="rounded bg-sky-100 text-sky-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase whitespace-nowrap" title="Sold at vendor cost + freight — P&L neutral">at cost</span> : a.beneficiary === 'both' ? 'Both' : a.beneficiary}</TableCell>
                    <TableCell className="text-right">
                      {a.pricing === 'cost' ? (
                        a.received_at ? (
                          <span className="text-green-700">{fmtUSD(a.expected_usd)}<span className="block text-[10px] font-normal">received {fmtDate(a.received_at)}</span></span>
                        ) : (
                          <span className="text-amber-700">
                            awaiting {fmtUSD(a.expected_usd)}
                            <Button size="sm" variant="outline" className="block h-6 px-1.5 mt-0.5 ml-auto text-[11px]"
                              onClick={() => doMarkReceived({ adjustment_id: a.id, actor: userName }).then(() => reloadAdj())}>
                              Mark received
                            </Button>
                          </span>
                        )
                      ) : fmtUSD(a.value_usd)}
                    </TableCell>
                    <TableCell>{a.reason}</TableCell>
                    <TableCell>{a.created_by}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{fmtDateTime(a.created_at)}</TableCell>
                    <TableCell>
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-red-600"
                        onClick={() => doDelAdj({ id: a.id }).then(() => { reloadAdj(); reloadCampaign(); })}>
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {adjustments.length === 0 && (
                  <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground py-6">No adjustments.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </TabsContent>

        <TabsContent value="catalog" className="mt-4 space-y-4">
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Mass</TableHead>
                  <TableHead>Ordering-app ID</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map(p => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.sku_code}</TableCell>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>{p.mass_label || '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{p.external_id || '—'}</TableCell>
                    <TableCell>{p.active ? 'yes' : 'no'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Card className="max-w-2xl">
            <CardHeader className="pb-2"><CardTitle className="text-base">Add product</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex gap-2">
                <Input placeholder="SKU (matches import 'Items')" value={npSku} onChange={e => setNpSku(e.target.value)} className="h-9 w-48" />
                <Input placeholder="Name" value={npName} onChange={e => setNpName(e.target.value)} className="h-9 flex-1" />
                <Input placeholder="Mass (60mg)" value={npMass} onChange={e => setNpMass(e.target.value)} className="h-9 w-28" />
                <Button size="sm" onClick={addProduct}>Add</Button>
              </div>
              {npError && <p className="text-sm text-red-600">{npError}</p>}
              <p className="text-xs text-muted-foreground">The SKU must match exactly how the ordering app writes it in the Items column.</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sync" className="mt-4">
          <OrderingAppSync products={products} onImported={reloadProducts} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
