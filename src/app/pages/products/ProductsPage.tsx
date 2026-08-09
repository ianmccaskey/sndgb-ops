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
import { useApp } from '@/app/AppContext';
import { OrderingAppSync } from '@/app/pages/products/OrderingAppSync';
import { rows } from '@/lib/rows';
import { fmtUSD, fmtNum, fmtDateTime } from '@/lib/fmt';
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
};
type Adjustment = { id: number; sku_code: string; qty: string; reason: string; created_by: string; created_at: string };

export function ProductsPage() {
  const { groupBuyId, userName } = useApp();
  const enabled = groupBuyId != null;

  const [rawProducts, , , reloadProducts] = useLoadAction(listProducts, [], {});
  const [rawVendors] = useLoadAction(listVendors, [], {});
  const [rawCampaign, , , reloadCampaign] = useLoadAction(listCampaignProducts, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const [rawAdj, , , reloadAdj] = useLoadAction(listAdjustments, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });

  const products = rows<Product>(rawProducts);
  const vendors = rows<Vendor>(rawVendors);
  const campaign = rows<CampaignProduct>(rawCampaign);
  const adjustments = rows<Adjustment>(rawAdj);

  const [doSaveProduct] = useMutateAction(saveProduct);
  const [doUpsertCampaign] = useMutateAction(upsertCampaignProduct);
  const [doMarkOrdered] = useMutateAction(markOrderedFromVendor);
  const [doAddAdj] = useMutateAction(addAdjustment);
  const [doDelAdj] = useMutateAction(deleteAdjustment);

  // add-to-campaign form
  const [cProduct, setCProduct] = useState('');
  const [cVendor, setCVendor] = useState('');
  const [cCost, setCCost] = useState('');
  const [cPrice, setCPrice] = useState('');
  const [cMoq, setCMoq] = useState('');
  const [cTesting, setCTesting] = useState('225');
  const [cFreight, setCFreight] = useState('0');
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
  const [aError, setAError] = useState('');

  const saveCampaignProduct = async () => {
    const cost = Number(cCost);
    const price = Number(cPrice);
    if (!cProduct || !cVendor || !(cost >= 0) || !(price >= 0) || !(Number(cMoq) >= 0)) {
      setCError('Product, vendor, cost, GB price, and MOQ are required.');
      return;
    }
    // The DB stores margin (GB price = cost + margin, computed). Derive it here
    // so the organizer only ever types the customer-facing price.
    const margin = +(price - cost).toFixed(2);
    if (margin < 0) {
      setCError(`GB price ($${price}) can't be below your unit cost ($${cost}).`);
      return;
    }
    setCError('');
    try {
      await doUpsertCampaign({
        group_buy_id: groupBuyId, product_id: Number(cProduct), vendor_id: Number(cVendor),
        unit_cost_usd: cost, margin_usd: margin, target_moq: Number(cMoq),
        testing_cost_usd: Number(cTesting || 0), freight_usd: Number(cFreight || 0),
      });
      setCProduct(''); setCCost(''); setCPrice(''); setCMoq('');
      reloadCampaign();
    } catch (e: unknown) {
      setCError(e instanceof Error ? e.message : 'Failed to save');
    }
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

  const addAdj = async () => {
    const qty = Number(aQty);
    if (!aProduct || !qty || !aReason.trim()) {
      setAError('Product, non-zero qty, and reason are all required — adjustments are audited.');
      return;
    }
    setAError('');
    try {
      await doAddAdj({ group_buy_product_id: Number(aProduct), qty, reason: aReason.trim(), created_by: userName });
      setAQty(''); setAReason('');
      reloadAdj(); reloadCampaign();
    } catch (e: unknown) {
      setAError(e instanceof Error ? e.message : 'Failed to add adjustment');
    }
  };

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Package className="h-6 w-6 text-violet-600" /> Products & Campaign Setup
        </h1>
        <p className="text-sm text-muted-foreground mt-1">One quantity basis everywhere: demand + adjustments = final count.</p>
      </div>

      <Tabs defaultValue="campaign">
        <TabsList>
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
                  <TableHead>Vendor order</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaign.map(c => (
                  <TableRow key={c.group_buy_product_id}>
                    <TableCell className="font-medium">{c.sku_code}</TableCell>
                    <TableCell>{c.vendor_code}</TableCell>
                    <TableCell className="text-right">{fmtUSD(c.unit_cost_usd)}</TableCell>
                    <TableCell className="text-right">{fmtUSD(c.margin_usd)}</TableCell>
                    <TableCell className="text-right font-medium">{fmtUSD(c.gb_price_usd)}</TableCell>
                    <TableCell className="text-right">{fmtNum(c.target_moq)}</TableCell>
                    <TableCell className={`text-right ${c.moq_met ? 'text-green-700 font-medium' : ''}`}>{fmtNum(c.demand_qty)}</TableCell>
                    <TableCell className="text-right font-medium">{fmtNum(c.final_count)}</TableCell>
                    <TableCell className="text-right">{fmtUSD(c.owed_to_vendor_usd, { cents: false })}</TableCell>
                    <TableCell className="text-right text-green-700">{fmtUSD(c.total_product_profit_usd, { cents: false })}</TableCell>
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
                  </TableRow>
                ))}
                {campaign.length === 0 && (
                  <TableRow><TableCell colSpan={11} className="text-center text-muted-foreground py-6">No products in this campaign yet — add one below.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          <Card className="max-w-3xl">
            <CardHeader className="pb-2"><CardTitle className="text-base">Add / update campaign product</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Select value={cProduct} onValueChange={setCProduct}>
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
                <Input placeholder="Unit cost $" value={cCost} onChange={e => setCCost(e.target.value)} className="h-9 w-28" />
                <Input placeholder="GB price $ (to customer)" value={cPrice} onChange={e => setCPrice(e.target.value)} className="h-9 w-44" />
                <Input placeholder="Target MOQ" value={cMoq} onChange={e => setCMoq(e.target.value)} className="h-9 w-28" />
                <Input placeholder="Testing $" value={cTesting} onChange={e => setCTesting(e.target.value)} className="h-9 w-24" />
                <Input placeholder="Freight $" value={cFreight} onChange={e => setCFreight(e.target.value)} className="h-9 w-24" />
              </div>
              {cCost !== '' && cPrice !== '' && Number(cPrice) >= Number(cCost) && (
                <p className="text-xs text-muted-foreground">Margin per unit: ${(Number(cPrice) - Number(cCost)).toFixed(2)}</p>
              )}
              {cError && <p className="text-sm text-red-600">{cError}</p>}
              <Button size="sm" onClick={saveCampaignProduct}>Save</Button>
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
                <Input placeholder="Reason (e.g. 'P&P personal x100')" value={aReason} onChange={e => setAReason(e.target.value)} className="h-9 flex-1 min-w-48" />
                <Button size="sm" onClick={addAdj}>Add</Button>
              </div>
              {aError && <p className="text-sm text-red-600">{aError}</p>}
            </CardContent>
          </Card>
          <div className="border rounded-lg overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
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
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No adjustments.</TableCell></TableRow>
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
