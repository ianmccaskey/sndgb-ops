import React, { useMemo, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listReceiveAddresses from '@/actions/receiving/listReceiveAddresses';
import listInboundPackages from '@/actions/receiving/listInboundPackages';
import listAddressInventory from '@/actions/receiving/listAddressInventory';
import listTransfers from '@/actions/receiving/listTransfers';
import listDestinations from '@/actions/receiving/listDestinations';
import listProducts from '@/actions/products/listProducts';
import listShippingVendors from '@/actions/receiving/listShippingVendors';
import updatePackageTracking from '@/actions/receiving/updatePackageTracking';
import markPackageReceived from '@/actions/receiving/markPackageReceived';
import { trackPackage, isTestKey } from '@/lib/shippo';
import { useShippoHttp } from '@/lib/useShippoHttp';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PackageOpen } from 'lucide-react';
import { DashboardTab } from './DashboardTab';
import { InventoryTab } from './InventoryTab';
import { TransfersTab } from './TransfersTab';
import { AddressesTab } from './AddressesTab';
import { ImportTab } from './ImportTab';
import type { RxAddress, Pkg, InvRow, TransferRow, CatalogProduct, VendorRow } from './shared';

/*
 * Receiving: what's coming, where it is, and whether it was transferred.
 * Entirely OUTSIDE the money subsystem — nothing here touches P&L, recon,
 * or vendor ledgers. Shippo calls run browser-side (CORS-verified) with
 * the key from Settings; TEST keys simulate tracking, so auto-receive is
 * suppressed in test mode (fake DELIVERED must never move real inventory).
 * Shared types + display helpers live in ./shared.ts.
 */

export function ReceivingPage() {
  const { userName, settings, groupBuyId } = useApp();
  const shippoKey = settings.shippo_api_key || '';
  const testMode = shippoKey !== '' && isTestKey(shippoKey);
  const shippoHttp = useShippoHttp();

  const [rawAddresses, , , reloadAddresses] = useLoadAction(listReceiveAddresses, [], {});
  const [rawPackages, , , reloadPackages] = useLoadAction(listInboundPackages, [], {});
  const [rawInventory, , , reloadInventory] = useLoadAction(listAddressInventory, [], {});
  const [rawTransfers, , , reloadTransfers] = useLoadAction(listTransfers, [], {});
  const [rawDestinations, , , reloadDestinations] = useLoadAction(listDestinations, [], {});
  const [rawProducts] = useLoadAction(listProducts, [], {});
  // only vendors that actually ship product IN THE SELECTED CAMPAIGN (no
  // COA vendors, no niche/unused vendor rows) — see listShippingVendors.
  // Gated like every other campaign-scoped load: groupBuyId is null until
  // AppContext resolves the selection.
  const [rawVendors, vendorsLoading, vendorsError] = useLoadAction(listShippingVendors, [groupBuyId], { group_buy_id: groupBuyId }, { enabled: groupBuyId != null });
  // the list is AUTHORITATIVE (safe to invalidate selections against, even
  // when empty) only once it has resolved cleanly for the current campaign
  const vendorsReady = groupBuyId != null && !vendorsLoading && !vendorsError;

  const addresses = rows<RxAddress>(rawAddresses);
  // the action transport returns all-digit text columns as JS numbers, so
  // an all-numeric tracking number would crash every .trim()/.toUpperCase()
  // downstream (Shippo path, correction dialog seed) — re-string them once
  // at the row boundary so every consumer sees the DB's text value
  const packages = useMemo(() => rows<Pkg>(rawPackages).map(p => ({
    ...p, carrier: String(p.carrier ?? ''), tracking_number: String(p.tracking_number ?? ''),
  })), [rawPackages]);
  const inventory = rows<InvRow>(rawInventory);
  const transfers = rows<TransferRow>(rawTransfers);
  const destinations = rows<RxAddress>(rawDestinations);
  const products = useMemo(() => rows<CatalogProduct>(rawProducts).filter(p => p.active), [rawProducts]);
  const vendors = rows<VendorRow>(rawVendors);

  const [doUpdateTracking] = useMutateAction(updatePackageTracking);
  const [doMarkReceived] = useMutateAction(markPackageReceived);

  // ---- tracking refresh engine (shared by per-package and refresh-all) ----
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [refreshAllProgress, setRefreshAllProgress] = useState('');

  const refreshOne = async (p: Pkg): Promise<string | null> => {
    if (!shippoKey) return 'Add your Shippo API token in Settings first.';
    setRefreshingIds(s => new Set(s).add(p.id));
    try {
      const r = await trackPackage(shippoHttp, shippoKey, p.carrier, p.tracking_number);
      // carrier + tracking travel with the write: if another session
      // corrected this package meanwhile, the CAS in the action refuses
      // and this stale snapshot is discarded instead of poisoning the row
      const wrote = await doUpdateTracking({
        package_id: p.id, carrier: p.carrier, tracking_number: p.tracking_number,
        status: r.status || '', substatus: r.substatus || '', detail: r.detail || '',
        error: r.error || '', location: r.location ? JSON.stringify(r.location) : '',
        eta: r.eta || '', status_date: r.statusDate || '',
      }) as unknown[] | null;
      if (!(Array.isArray(wrote) ? wrote.length > 0 : !!wrote)) {
        return 'This package\'s carrier/tracking was corrected in another session — refresh skipped; reload the page.';
      }
      // auto-receive ONLY on a live key: test tokens simulate DELIVERED and
      // must never move real inventory. Checked against BOTH the fresh fetch
      // and the row's prior status, so a package stuck DELIVERED-but-
      // unreceived (a previously failed auto-receive) recovers on any
      // refresh instead of being stranded. A manual un-receive sets
      // auto_receive_suppressed so it STICKS — the action also refuses
      // 'auto' mode DB-side while suppressed (this check just avoids the
      // pointless call).
      if (!testMode && !p.received_at && !p.auto_receive_suppressed && (r.status === 'DELIVERED' || p.tracking_status === 'DELIVERED')) {
        await doMarkReceived({ package_id: p.id, carrier: p.carrier, tracking_number: p.tracking_number, actor: userName, mode: 'auto' });
        reloadInventory();
      }
      return r.error;
    } catch (e: unknown) {
      return e instanceof Error ? e.message : 'Refresh failed';
    } finally {
      setRefreshingIds(s => { const n = new Set(s); n.delete(p.id); return n; });
    }
  };

  const refreshAll = async () => {
    // skip only truly terminal rows (received). DELIVERED-but-unreceived
    // stays IN the set: it means an earlier auto-receive failed (or test
    // mode), and skipping it would strand inventory understated forever.
    const targets = packages.filter(p => p.committed_at && !p.received_at);
    if (targets.length === 0) { setRefreshAllProgress('Nothing to refresh.'); return; }
    let done = 0;
    for (const p of targets) {
      setRefreshAllProgress(`${done}/${targets.length} refreshed…`);
      await refreshOne(p);
      done += 1;
      await new Promise(r => setTimeout(r, 250)); // gentle pacing on top of backoff
    }
    setRefreshAllProgress(`${done}/${targets.length} refreshed.`);
    reloadPackages();
  };

  const afterPackageChange = () => { reloadPackages(); reloadInventory(); };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <PackageOpen className="h-6 w-6 text-violet-600" /> Receiving
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          What's coming, where it is, and whether it was transferred — tracked via Shippo, outside the money books.
        </p>
        {testMode && (
          <p className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 p-2 mt-2">
            Shippo TEST MODE — tracking data is simulated and auto-receive is OFF. Labels purchased are test labels.
          </p>
        )}
        {!shippoKey && (
          <p className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 p-2 mt-2">
            No Shippo API token yet — packages can be logged, but tracking and transfer labels need the token (Settings).
          </p>
        )}
      </div>

      <Tabs defaultValue="dashboard">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="transfers">Transfers</TabsTrigger>
          <TabsTrigger value="addresses">Addresses</TabsTrigger>
          <TabsTrigger value="import">Import CSV</TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <DashboardTab
            addresses={addresses} packages={packages} products={products} vendors={vendors} vendorsReady={vendorsReady}
            refreshOne={refreshOne} refreshAll={refreshAll} refreshingIds={refreshingIds}
            refreshAllProgress={refreshAllProgress} afterChange={afterPackageChange}
            hasKey={!!shippoKey} testMode={testMode}
          />
        </TabsContent>
        <TabsContent value="inventory" className="mt-4">
          <InventoryTab inventory={inventory} addresses={addresses} />
        </TabsContent>
        <TabsContent value="transfers" className="mt-4">
          <TransfersTab
            addresses={addresses} destinations={destinations} products={products} packages={packages}
            transfers={transfers} inventory={inventory} shippoKey={shippoKey} shippoHttp={shippoHttp} testMode={testMode}
            reloadTransfers={() => { reloadTransfers(); reloadInventory(); }}
            reloadDestinations={reloadDestinations}
          />
        </TabsContent>
        <TabsContent value="addresses" className="mt-4">
          <AddressesTab
            addresses={addresses} destinations={destinations}
            reloadAddresses={reloadAddresses} reloadDestinations={reloadDestinations}
          />
        </TabsContent>
        <TabsContent value="import" className="mt-4">
          <ImportTab
            addresses={addresses} vendors={vendors} products={products}
            reloadAddresses={reloadAddresses} afterPackageChange={afterPackageChange}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
