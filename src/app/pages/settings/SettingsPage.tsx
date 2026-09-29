import React, { useEffect, useState } from 'react';
import { useMutateAction, useLoadAction } from '@uibakery/data';
import saveSetting from '@/actions/settings/saveSetting';
import updateGroupBuy from '@/actions/groupBuys/updateGroupBuy';
import createGroupBuy from '@/actions/groupBuys/createGroupBuy';
import saveProfitSplit from '@/actions/financials/saveProfitSplit';
import deleteProfitSplit from '@/actions/financials/deleteProfitSplit';
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
type PnlRow = {
  splits: { party: string; pct: string }[] | null;
  adjustments: { beneficiary: string; value_usd: string; count: string }[] | null;
};

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
  const [doDeleteSplit] = useMutateAction(deleteProfitSplit);
  const [doUpdateWallet] = useMutateAction(updateWallet);

  const [rawWallets, , , reloadWallets] = useLoadAction(listWallets, [], {});
  const wallets = rows<WalletRow>(rawWallets);
  const [rawPnl, pnlLoading, , reloadPnl] = useLoadAction(getPnl, [groupBuyId], { group_buy_id: groupBuyId }, { enabled: groupBuyId != null });
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
  const [boxTare, setBoxTare] = useState('');
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
  const [splitSaving, setSplitSaving] = useState(false);
  const [removingParty, setRemovingParty] = useState<string | null>(null);
  const [newParty, setNewParty] = useState('');

  // in-progress edits belong to the campaign they were typed on — switching
  // campaigns must not carry them over (Save writes to the CURRENT groupBuyId)
  useEffect(() => { setSplitEdits({}); setNewParty(''); setSplitMsg(''); }, [groupBuyId]);

  const splitParties = Array.from(new Set([...splits.map(s => s.party), ...Object.keys(splitEdits)]));
  const splitVal = (p: string) => splitEdits[p] ?? String(Number(splits.find(s => s.party === p)?.pct ?? 0));
  const splitTotal = splitParties.reduce((t, p) => t + Number(splitVal(p) || 0), 0);
  const splitAdjustments = firstRow<PnlRow>(rawPnl)?.adjustments || [];

  const removeParty = async (party: string) => {
    setSplitMsg('');
    if (!splits.some(s => s.party === party)) {
      // never saved — purely local
      setSplitEdits(m => { const n = { ...m }; delete n[party]; return n; });
      return;
    }
    const adj = splitAdjustments.find(a => a.beneficiary === party);
    if (adj && Number(adj.count) > 0) {
      setSplitMsg(`${party} has ${adj.count} adjustment${Number(adj.count) === 1 ? '' : 's'} attributed to them in this campaign — remove those on Products → Admin adjustments first, or set them to 0% instead (0% always works).`);
      return;
    }
    const pct = Number(splitVal(party)) || 0;
    if (!window.confirm(`Remove ${party} (currently ${pct}%) from this campaign's profit split? Only this campaign is affected${pct > 0 ? `; the split will total ${+(splitTotal - pct).toFixed(2)}% until you re-save` : ''}.`)) return;
    setRemovingParty(party);
    try {
      const res = await doDeleteSplit({ group_buy_id: groupBuyId, party }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
        setSplitMsg(`${party} was not removed — the row is already gone, or adjustments were just attributed to them. Reloading to show the current state.`);
      } else {
        setSplitMsg(`Removed ${party}.`);
      }
      setSplitEdits(m => { const n = { ...m }; delete n[party]; return n; });
      reloadPnl();
    } catch (e: unknown) {
      setSplitMsg(e instanceof Error ? e.message : `Failed to remove ${party}`);
    } finally {
      setRemovingParty(null);
    }
  };

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
    setBoxTare(settings.default_box_tare_oz || '');
  }, [settings.shippo_api_key, settings.default_box_tare_oz]);

  const saveShippo = async () => {
    setShippoMsg('');
    if (boxTare.trim() !== '' && !/^\d+(?:\.\d{1,2})?$/.test(boxTare.trim())) {
      setShippoMsg('Box tare must be a positive number in oz (max 2 decimals), or blank.');
      return;
    }
    try {
      await doSaveSetting({ key: 'shippo_api_key', value: shippoKey.trim() });
      await doSaveSetting({ key: 'default_box_tare_oz', value: boxTare.trim() });
      reloadSettings();
      setShippoMsg('Saved.');
    } catch (e: unknown) {
      setShippoMsg(e instanceof Error ? e.message : 'Failed to save');
    }
  };

  // GET + POST probes through the FULL chain (datasource → backend →
  // Shippo → key) so a missing or drifted "Shippo API" datasource fails
  // fast here instead of mid-purchase on the Receiving page. Tests the
  // PERSISTED key — the one Receiving/Transfers actually run with — not
  // whatever sits unsaved in the field.
  const testShippo = async () => {
    const saved = (settings.shippo_api_key || '').trim();
    if (!saved) { setShippoMsg('Save the token first — the test verifies the SAVED key the app runs with.'); return; }
    setShippoTesting(true); setShippoMsg('Testing…');
    try {
      const r = await testShippoConnection(shippoHttp, saved);
      const unsavedNote = shippoKey.trim() !== saved ? ' (NOTE: the field above has unsaved changes — this tested the SAVED key.)' : '';
      setShippoMsg((r.ok ? '✓ ' : '✗ ') + r.message + unsavedNote);
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

  const addParty = () => {
    const name = newParty.trim();
    if (!name) return;
    // 'paige' vs 'Paige' would become two DB rows — treat names
    // case-insensitively and keep the casing that already exists
    if (!splitParties.some(p => p.toLowerCase() === name.toLowerCase())) {
      setSplitEdits(m => ({ ...m, [name]: '' }));
    }
    setNewParty('');
    setSplitMsg('');
  };

  const saveSplits = async () => {
    setSplitMsg('');
    let total = 0;
    const values: { party: string; pct: number }[] = [];
    for (const p of splitParties) {
      const raw = splitVal(p);
      // a freshly added person left blank should not silently become
      // a permanent 0% row
      if (!splits.some(s => s.party === p) && raw.trim() === '') {
        setSplitMsg(`Set a percentage for ${p}, or remove them.`); return;
      }
      const pct = Number(raw);
      if (Number.isNaN(pct)) { setSplitMsg(`${p}'s percentage isn't a number.`); return; }
      // 0% rows are still written — skipping them would leave a zeroed
      // party's OLD percentage alive in the DB and the stored splits over 100
      values.push({ party: p, pct }); total += pct;
    }
    if (Math.abs(total - 100) > 0.01) { setSplitMsg(`Splits must total 100% (currently ${+total.toFixed(2)}%).`); return; }
    setSplitSaving(true);
    try {
      for (const v of values) {
        await doSaveSplit({ group_buy_id: groupBuyId, party: v.party, pct: v.pct });
      }
      reloadPnl();
      setSplitMsg('Saved.');
    } catch (e: unknown) {
      setSplitMsg(e instanceof Error ? e.message : 'Failed to save splits');
    } finally {
      setSplitSaving(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2 text-gradient">
          <SettingsIcon className="h-6 w-6 text-cyan-300" /> Settings
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
        <CardContent className="space-y-3">
          {pnlLoading && splitParties.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading splits…</p>
          ) : splitParties.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one shares this campaign's profit yet — add each person below, then set the percentages.</p>
          ) : (
            <div className="flex flex-wrap gap-3 items-end">
              {splitParties.map(party => {
                const unsaved = !splits.some(s => s.party === party);
                const removeLabel = unsaved ? `Remove ${party} (not saved yet)` : `Remove ${party} from this campaign's split`;
                return (
                  <div key={party} className={`space-y-1 ${removingParty === party ? 'opacity-50' : ''}`}>
                    <Label className="text-xs">{party} %{unsaved && <span className="text-amber-300"> · unsaved</span>}</Label>
                    <div className="flex items-center gap-1">
                      <Input
                        inputMode="decimal" placeholder="0"
                        value={splitVal(party)}
                        onChange={e => setSplitEdits(m => ({ ...m, [party]: e.target.value }))}
                        className="h-9 w-24"
                      />
                      <button className="h-9 w-9 -m-1 flex items-center justify-center shrink-0 text-xs opacity-60 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:outline-none rounded disabled:opacity-30"
                        title={removeLabel} aria-label={removeLabel} disabled={removingParty !== null}
                        onClick={() => removeParty(party)}>✕</button>
                    </div>
                  </div>
                );
              })}
              <p className="text-xs text-muted-foreground pb-2.5">
                Total: <span className={Math.abs(splitTotal - 100) <= 0.01 ? 'text-emerald-300 font-medium' : 'text-amber-300 font-medium'}>
                  {Number.isNaN(splitTotal) ? '?' : +splitTotal.toFixed(2)}</span> of 100
              </p>
            </div>
          )}
          <div className="flex gap-2 items-end">
            <div className="space-y-1">
              <Label className="text-xs">Add person</Label>
              <Input placeholder="e.g. Paige" value={newParty} onChange={e => setNewParty(e.target.value)} className="h-9 w-40"
                onKeyDown={e => { if (e.key === 'Enter') addParty(); }} />
            </div>
            <Button size="sm" variant="outline" className="h-9" disabled={!newParty.trim()} onClick={addParty}>Add</Button>
          </div>
          {splitMsg && <p className={`text-sm ${splitMsg === 'Saved.' || splitMsg.startsWith('Removed ') ? 'text-muted-foreground' : 'text-amber-300'}`}>{splitMsg}</p>}
          <Button size="sm" disabled={splitSaving} onClick={saveSplits}>{splitSaving ? 'Saving…' : 'Save splits'}</Button>
          <p className="text-xs text-muted-foreground">Percentages must total 100. ✕ removes a person from this campaign; anyone with adjustments attributed to them must be 0% instead. New people save on Save splits.</p>
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
            <Field label="Default box tare (oz)" value={boxTare} onChange={setBoxTare} placeholder="e.g. 6" />
          </div>
          <p className="text-xs text-muted-foreground -mt-1">
            Tare = empty box + packaging weight, added to the shipping modal's auto-calculated weight (product weights come from the Products page). Always adjustable per shipment.
          </p>
          {shippoKey.trim().toLowerCase().startsWith('shippo_test') && (
            <p className="text-xs rounded border border-amber-400/40 bg-amber-400/5 text-amber-200 p-2">
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
