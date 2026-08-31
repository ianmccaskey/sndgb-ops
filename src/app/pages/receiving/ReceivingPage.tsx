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
import { trackPackage, isTestKey } from '@/lib/shippo';
import { useShippoHttp } from '@/lib/useShippoHttp';
import { useApp } from '@/app/AppContext';
import { rows, dbText } from '@/lib/rows';
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
 * the key from Settings. Tracking refreshes NEVER receive a package:
 * carrier-DELIVERED means it is on the porch; receiving = the operator
 * opened it and confirmed contents (explicit Receive / label scan).
 * Shared types + display helpers live in ./shared.ts.
 */

export function ReceivingPage() {
  const { settings, groupBuyId } = useApp();
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
  // row boundary: tracking numbers travel from the actions behind a '#'
  // guard ('#' || tracking_number) so a 22-digit USPS number survives the
  // transport's digit-only-text-to-JS-number re-typing intact — dbText()
  // strips the guard. A bare NUMBER here means an old action build; the
  // fail-closed mangle flag stays as dead defense for values past
  // Number.MAX_SAFE_INTEGER (refresh/correction refuse with an honest
  // message instead of acting on a rounded number).
  const packages = useMemo(() => rows<Pkg>(rawPackages).map(p => {
    const rawTracking = p.tracking_number as unknown;
    const mangled = typeof rawTracking === 'number' && !Number.isSafeInteger(rawTracking);
    return { ...p, carrier: String(p.carrier ?? ''), tracking_number: dbText(rawTracking), tracking_mangled: mangled };
  }), [rawPackages]);
  const inventory = rows<InvRow>(rawInventory);
  const transfers = useMemo(() => rows<TransferRow>(rawTransfers).map(t => ({
    ...t, tracking_number: t.tracking_number == null ? null : dbText(t.tracking_number),
  })), [rawTransfers]);
  const destinations = rows<RxAddress>(rawDestinations);
  const products = useMemo(() => rows<CatalogProduct>(rawProducts).filter(p => p.active), [rawProducts]);
  const vendors = rows<VendorRow>(rawVendors);

  const [doUpdateTracking] = useMutateAction(updatePackageTracking);

  // ---- tracking refresh engine (shared by per-package and refresh-all) ----
  const [refreshingIds, setRefreshingIds] = useState<Set<number>>(new Set());
  const [refreshAllProgress, setRefreshAllProgress] = useState('');

  const refreshOne = async (p: Pkg): Promise<string | null> => {
    if (!shippoKey) return 'Add your Shippo API token in Settings first.';
    if (p.tracking_mangled) return 'Refresh blocked: the platform returned this tracking number rounded (too many digits to survive as a number), so refreshing would track the WRONG number. Delete this package and re-log it — the record in the database is intact.';
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
      // NO auto-receive (removed 2026-08-30 per Ian): carrier-DELIVERED
      // means the box is on the porch, not that its contents were opened
      // and confirmed — receiving is ALWAYS the explicit Receive action
      // (or label scan). The refresh only updates the tracking display.
      return r.error;
    } catch (e: unknown) {
      return e instanceof Error ? e.message : 'Refresh failed';
    } finally {
      setRefreshingIds(s => { const n = new Set(s); n.delete(p.id); return n; });
    }
  };

  const refreshAll = async () => {
    // skip only truly terminal rows (received). DELIVERED-but-unreceived
    // stays IN the set — the operator has not opened/confirmed it yet,
    // and later tracking events (returns, exceptions) still matter.
    const targets = packages.filter(p => p.committed_at && !p.received_at);
    if (targets.length === 0) { setRefreshAllProgress('Nothing to refresh.'); return; }
    // a non-null return is a package that did NOT get a clean refresh
    // (blocked mangled tracking, Shippo failure) — counting it as
    // "refreshed" would hide rows that need operator action
    let ok = 0, failed = 0;
    for (const p of targets) {
      setRefreshAllProgress(`${ok + failed}/${targets.length} refreshed…`);
      const err = await refreshOne(p);
      if (err) failed += 1; else ok += 1;
      await new Promise(r => setTimeout(r, 250)); // gentle pacing on top of backoff
    }
    setRefreshAllProgress(failed === 0
      ? `${ok}/${targets.length} refreshed.`
      : `${ok}/${targets.length} refreshed — ${failed} had problems; use those packages' own Refresh button for the reason.`);
    reloadPackages();
  };

  const afterPackageChange = () => { reloadPackages(); reloadInventory(); };

  // "Part out" on a received package card jumps to the Transfers tab with
  // that box preselected and ship-from set to its transfer-origin group
  const [tab, setTab] = useState('dashboard');
  const [partOutSeed, setPartOutSeed] = useState<{ boxId: number; from: string } | null>(null);
  const partOut = (p: Pkg) => {
    const a = addresses.find(x => Number(x.id) === Number(p.receive_address_id));
    const origin = a ? String(a.transfer_origin_id ?? a.id) : String(p.receive_address_id);
    setPartOutSeed({ boxId: Number(p.id), from: origin });
    setTab('transfers');
  };

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
            Shippo TEST MODE — tracking data is simulated. Labels purchased are test labels.
          </p>
        )}
        {!shippoKey && (
          <p className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 p-2 mt-2">
            No Shippo API token yet — packages can be logged, but tracking and transfer labels need the token (Settings).
          </p>
        )}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
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
            hasKey={!!shippoKey} testMode={testMode} onPartOut={partOut}
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
            partOutSeed={partOutSeed} onPartOutSeedConsumed={() => setPartOutSeed(null)}
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
