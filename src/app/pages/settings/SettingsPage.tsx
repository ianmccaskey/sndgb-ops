import React, { useEffect, useState } from 'react';
import { useMutateAction, useLoadAction } from '@uibakery/data';
import saveSetting from '@/actions/settings/saveSetting';
import updateGroupBuy from '@/actions/groupBuys/updateGroupBuy';
import createGroupBuy from '@/actions/groupBuys/createGroupBuy';
import saveProfitSplit from '@/actions/financials/saveProfitSplit';
import getPnl from '@/actions/financials/getPnl';
import listWallets from '@/actions/financials/listWallets';
import updateWallet from '@/actions/financials/updateWallet';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { testShippoConnection } from '@/lib/shippo';
import { useShippoHttp } from '@/lib/useShippoHttp';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Settings as SettingsIcon } from 'lucide-react';

type WalletRow = { id: number; name: string; chain: string; address: string | null; active: boolean };
type PnlRow = { splits: { party: string; pct: string }[] | null };

function Field({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} className="h-9" />
    </div>
  );
}

export function SettingsPage() {
  const { groupBuy, groupBuyId, settings, reloadSettings, reloadGroupBuys } = useApp();
  const [doSaveSetting] = useMutateAction(saveSetting);
  const [doUpdateGb] = useMutateAction(updateGroupBuy);
  const [doCreateGb] = useMutateAction(createGroupBuy);
  const [doSaveSplit] = useMutateAction(saveProfitSplit);
  const [doUpdateWallet] = useMutateAction(updateWallet);

  const [rawWallets, , , reloadWallets] = useLoadAction(listWallets, [], {});
  const wallets = rows<WalletRow>(rawWallets);
  const [rawPnl, , , reloadPnl] = useLoadAction(getPnl, [groupBuyId], { group_buy_id: groupBuyId }, { enabled: groupBuyId != null });
  const splits = firstRow<PnlRow>(rawPnl)?.splits || [];

  // API keys / addresses
  const [moralisKey, setMoralisKey] = useState('');
  const [heliusKey, setHeliusKey] = useState('');
  const [keysMsg, setKeysMsg] = useState('');

  // ordering app (base44)
  const [b44AppId, setB44AppId] = useState('');
  const [b44Token, setB44Token] = useState('');
  const [b44Msg, setB44Msg] = useState('');

  // shippo (package tracking + transfer labels)
  const [shippoKey, setShippoKey] = useState('');
  const [shippoMsg, setShippoMsg] = useState('');
  const [shippoTesting, setShippoTesting] = useState(false);
  const shippoHttp = useShippoHttp();

  // campaign form
  const [gbName, setGbName] = useState('');
  const [gbStatus, setGbStatus] = useState('draft');
  const [gbStart, setGbStart] = useState('');
  const [gbEnd, setGbEnd] = useState('');
  const [gbAdminFee, setGbAdminFee] = useState('10');
  const [gbShipFee, setGbShipFee] = useState('10');
  const [gbCashPct, setGbCashPct] = useState('4.5');
  const [gbTolerance, setGbTolerance] = useState('1');
  const [gbMsg, setGbMsg] = useState('');

  // new campaign
  const [newName, setNewName] = useState('');
  const [newMsg, setNewMsg] = useState('');

  // splits
  const [splitEdits, setSplitEdits] = useState<Record<string, string>>({});
  const [splitMsg, setSplitMsg] = useState('');

  // wallet addresses
  const [walletEdits, setWalletEdits] = useState<Record<number, string>>({});

  useEffect(() => {
    setMoralisKey(settings.moralis_api_key || '');
    setHeliusKey(settings.helius_api_key || '');
  }, [settings.moralis_api_key, settings.helius_api_key]);

  useEffect(() => {
    setB44AppId(settings.base44_app_id || '');
    setB44Token(settings.base44_token || '');
  }, [settings.base44_app_id, settings.base44_token]);

  useEffect(() => {
    setShippoKey(settings.shippo_api_key || '');
  }, [settings.shippo_api_key]);

  const saveShippo = async () => {
    setShippoMsg('');
    try {
      await doSaveSetting({ key: 'shippo_api_key', value: shippoKey.trim() });
      reloadSettings();
      setShippoMsg('Saved.');
    } catch (e: unknown) {
      setShippoMsg(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  // one cheap read through the FULL chain (datasource → backend → Shippo
  // → key) so a missing or drifted "Shippo API" datasource fails fast
  // here instead of mid-purchase on the Receiving page
  const testShippo = async () => {
    if (!shippoKey.trim()) { setShippoMsg('Enter and save the token first.'); return; }
    setShippoTesting(true); setShippoMsg('Testing…');
    try {
      const r = await testShippoConnection(shippoHttp, shippoKey);
      setShippoMsg((r.ok ? '✓ ' : '✗ ') + r.message);
    } finally {
      setShippoTesting(false);
    }
  };

  useEffect(() => {
    if (groupBuy) {
      setGbName(groupBuy.name);
      setGbStatus(groupBuy.status);
      setGbStart(groupBuy.starts_on ? String(groupBuy.starts_on).slice(0, 10) : '');
      setGbEnd(groupBuy.ends_on ? String(groupBuy.ends_on).slice(0, 10) : '');
      setGbAdminFee(String(Number(groupBuy.admin_fee_usd)));
      setGbShipFee(String(Number(groupBuy.shipping_fee_usd)));
      setGbCashPct(String(Number(groupBuy.cash_processor_fee_pct)));
      setGbTolerance(String(Number(groupBuy.reconcile_tolerance_usd)));
    }
  }, [groupBuy?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveKeys = async () => {
    setKeysMsg('');
    try {
      await doSaveSetting({ key: 'moralis_api_key', value: moralisKey.trim() });
      await doSaveSetting({ key: 'helius_api_key', value: heliusKey.trim() });
      reloadSettings();
      setKeysMsg('Saved.');
    } catch (e: unknown) {
      setKeysMsg(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const saveB44 = async () => {
    setB44Msg('');
    try {
      await doSaveSetting({ key: 'base44_app_id', value: b44AppId.trim() });
      await doSaveSetting({ key: 'base44_token', value: b44Token.trim() });
      reloadSettings();
      setB44Msg('Saved.');
    } catch (e: unknown) {
      setB44Msg(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const saveWalletAddress = async (w: WalletRow) => {
    const address = (walletEdits[w.id] ?? w.address ?? '').trim();
    await doUpdateWallet({ id: w.id, address, active: w.active });
    // Keep the settings-table copies in sync — the recon verifier reads these.
    const settingKey = w.chain === 'eth' ? 'eth_wallet_address' : w.chain === 'sol' ? 'sol_wallet_address' : w.chain === 'base' ? 'base_wallet_address' : null;
    if (settingKey) await doSaveSetting({ key: settingKey, value: address });
    reloadWallets(); reloadSettings();
  };

  const saveCampaign = async () => {
    if (!groupBuy) return;
    setGbMsg('');
    try {
      await doUpdateGb({
        id: groupBuy.id, name: gbName, status: gbStatus, starts_on: gbStart, ends_on: gbEnd,
        admin_fee_usd: Number(gbAdminFee), shipping_fee_usd: Number(gbShipFee),
        cash_processor_fee_pct: Number(gbCashPct), reconcile_tolerance_usd: Number(gbTolerance),
        notes: groupBuy.notes || '',
      });
      reloadGroupBuys();
      setGbMsg('Saved.');
    } catch (e: unknown) {
      setGbMsg(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  const createCampaign = async () => {
    if (!newName.trim()) { setNewMsg('Name required.'); return; }
    setNewMsg('');
    try {
      await doCreateGb({ name: newName.trim(), starts_on: '', ends_on: '', admin_fee_usd: 10, shipping_fee_usd: 10, cash_processor_fee_pct: 4.5 });
      setNewName('');
      reloadGroupBuys();
      setNewMsg('Created — select it from the campaign picker.');
    } catch (e: unknown) {
      setNewMsg(e instanceof Error ? e.message : 'Failed to create');
    }
  };

  const saveSplits = async () => {
    setSplitMsg('');
    const parties = new Set([...splits.map(s => s.party), ...Object.keys(splitEdits)]);
    let total = 0;
    const values: { party: string; pct: number }[] = [];
    for (const p of parties) {
      const pct = Number(splitEdits[p] ?? splits.find(s => s.party === p)?.pct ?? 0);
      if (pct > 0) { values.push({ party: p, pct }); total += pct; }
    }
    if (Math.abs(total - 100) > 0.01) { setSplitMsg(`Splits must total 100% (currently ${total}%).`); return; }
    try {
      for (const v of values) {
        await doSaveSplit({ group_buy_id: groupBuyId, party: v.party, pct: v.pct });
      }
      reloadPnl();
      setSplitMsg('Saved.');
    } catch (e: unknown) {
      setSplitMsg(e instanceof Error ? e.message : 'Failed to save splits');
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <SettingsIcon className="h-6 w-6 text-violet-600" /> Settings
        </h1>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Campaign — {groupBuy?.name}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Field label="Name" value={gbName} onChange={setGbName} />
            <div className="space-y-1">
              <Label className="text-xs">Status</Label>
              <Select value={gbStatus} onValueChange={setGbStatus}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['draft', 'open', 'closed', 'ordering', 'fulfillment', 'complete'].map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Field label="Starts" value={gbStart} onChange={setGbStart} type="date" />
            <Field label="Ends" value={gbEnd} onChange={setGbEnd} type="date" />
            <Field label="Admin fee $ / order" value={gbAdminFee} onChange={setGbAdminFee} />
            <Field label="Shipping fee $ / order" value={gbShipFee} onChange={setGbShipFee} />
            <Field label="Cash processor fee %" value={gbCashPct} onChange={setGbCashPct} />
            <Field label="Recon tolerance $" value={gbTolerance} onChange={setGbTolerance} />
          </div>
          {gbMsg && <p className="text-sm text-muted-foreground">{gbMsg}</p>}
          <Button size="sm" onClick={saveCampaign}>Save campaign</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Profit split (this campaign)</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex flex-wrap gap-3">
            {splits.map(s => (
              <div key={s.party} className="space-y-1">
                <Label className="text-xs">{s.party} %</Label>
                <Input
                  value={splitEdits[s.party] ?? String(Number(s.pct))}
                  onChange={e => setSplitEdits(m => ({ ...m, [s.party]: e.target.value }))}
                  className="h-9 w-24"
                />
              </div>
            ))}
          </div>
          {splitMsg && <p className="text-sm text-muted-foreground">{splitMsg}</p>}
          <Button size="sm" onClick={saveSplits}>Save splits</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">New campaign</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input placeholder="e.g. Mixed Buy #6" value={newName} onChange={e => setNewName(e.target.value)} className="h-9 flex-1" />
            <Button size="sm" onClick={createCampaign}>Create</Button>
          </div>
          {newMsg && <p className="text-sm text-muted-foreground">{newMsg}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Ordering app (base44)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="App ID (from the base44 editor URL)" value={b44AppId} onChange={setB44AppId} placeholder="69157b827c06411f4ed6bf0f" />
            <Field label="API JWT" value={b44Token} onChange={setB44Token} type="password" />
          </div>
          {b44Msg && <p className="text-sm text-muted-foreground">{b44Msg}</p>}
          <Button size="sm" onClick={saveB44}>Save ordering app</Button>
          <p className="text-xs text-muted-foreground">
            Used by Products → Ordering app to pull each campaign's product list. Leave App ID blank to use the default.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Shippo (package tracking & transfer labels)</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Shippo API token" value={shippoKey} onChange={setShippoKey} type="password" placeholder="shippo_live_… or shippo_test_…" />
          </div>
          {shippoKey.trim().toLowerCase().startsWith('shippo_test') && (
            <p className="text-xs rounded border border-amber-300 bg-amber-50 text-amber-900 p-2">
              TEST token — tracking data on the Receiving page will be simulated and auto-receive is disabled; labels purchased are test labels.
            </p>
          )}
          {shippoMsg && <p className="text-sm text-muted-foreground break-all">{shippoMsg}</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={saveShippo}>Save Shippo token</Button>
            <Button size="sm" variant="outline" disabled={shippoTesting} onClick={testShippo}>{shippoTesting ? 'Testing…' : 'Test Shippo connection'}</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Powers inbound package tracking and transfer label purchases on the Receiving page. Enable UPS in your Shippo dashboard (Carriers) to see UPS rates.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Chain APIs & receiving wallets</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Moralis API key (ETH + BASE)" value={moralisKey} onChange={setMoralisKey} type="password" />
            <Field label="Helius API key (SOL)" value={heliusKey} onChange={setHeliusKey} type="password" />
          </div>
          {keysMsg && <p className="text-sm text-muted-foreground">{keysMsg}</p>}
          <Button size="sm" onClick={saveKeys}>Save keys</Button>
          <div className="space-y-2 pt-2 border-t">
            {wallets.filter(w => w.chain !== 'fiat').map(w => (
              <div key={w.id} className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label className="text-xs">{w.name} address</Label>
                  <Input
                    value={walletEdits[w.id] ?? w.address ?? ''}
                    onChange={e => setWalletEdits(m => ({ ...m, [w.id]: e.target.value }))}
                    placeholder={w.chain === 'sol' ? 'Solana address' : '0x…'}
                    className="h-9 font-mono text-xs"
                  />
                </div>
                <Button size="sm" variant="outline" onClick={() => saveWalletAddress(w)}>Save</Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Payment verification checks that funds landed in these addresses — without them, amounts are taken from the tx without a recipient check.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
