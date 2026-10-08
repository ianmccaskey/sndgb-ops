import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import getStorefrontCampaign from '@/actions/storefront/getStorefrontCampaign';
import upsertStorefrontCampaign from '@/actions/storefront/upsertStorefrontCampaign';
import listStorefrontPaymentOptions from '@/actions/storefront/listStorefrontPaymentOptions';
import addStorefrontPaymentOption from '@/actions/storefront/addStorefrontPaymentOption';
import setStorefrontPaymentOptionActive from '@/actions/storefront/setStorefrontPaymentOptionActive';
import getStorefrontOrderStats from '@/actions/storefront/getStorefrontOrderStats';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Globe, ExternalLink } from 'lucide-react';

/**
 * Storefront (p2collective.app) publishing for the selected campaign:
 * the storefront code that prefixes order numbers, the member-facing copy,
 * the wallets/handles members may pay on, and the published switch. Orders
 * placed there come back into this app through Import → "Refresh from
 * storefront"; nothing here touches the money views.
 */

type CampaignSettingsRow = {
  group_buy_id: number;
  code: string;
  published: boolean;
  description_md: string | null;
  payment_instructions_md: string | null;
  near_default_rail: string | null;
  insurance_rate_pct: string;
  next_order_seq: number;
};
type OptionRow = { id: number; rail: string; token: string; address: string; label: string | null; active: boolean; sort: number; orders_using: string };
type StatsRow = { unpaid: string; payment_submitted: string; paid: string; cancelled: string; not_imported: string; number_collisions: string; last_placed_at: string | null };

const STOREFRONT_ORIGIN = 'https://p2collective.app';
const RAIL_LABEL: Record<string, string> = { eth: 'Ethereum', sol: 'Solana', base: 'Base', cash: 'Cash' };
const CODE_RE = /^[A-Z0-9]{2,8}$/;

export function StorefrontPage() {
  const { groupBuyId, groupBuy, reloadGroupBuys } = useApp();
  const enabled = groupBuyId != null;

  const [rawCs, csLoading, , reloadCs] = useLoadAction(getStorefrontCampaign, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const cs = rows<CampaignSettingsRow>(rawCs)[0] ?? null;
  const [rawOpts, , , reloadOpts] = useLoadAction(listStorefrontPaymentOptions, [groupBuyId], { group_buy_id: groupBuyId }, { enabled });
  const options = rows<OptionRow>(rawOpts);
  const [rawStats, , , reloadStats] = useLoadAction(getStorefrontOrderStats, [groupBuyId], { group_buy_id: groupBuyId }, { enabled: enabled && !!cs });
  const stats = rows<StatsRow>(rawStats)[0] ?? null;

  const [doUpsert] = useMutateAction(upsertStorefrontCampaign);
  const [doAddOpt] = useMutateAction(addStorefrontPaymentOption);
  const [doSetActive] = useMutateAction(setStorefrontPaymentOptionActive);

  // form mirrors the stored row; re-seeded when the campaign or its row changes
  const [code, setCode] = useState('');
  const [published, setPublished] = useState(false);
  const [descriptionMd, setDescriptionMd] = useState('');
  const [paymentInstructionsMd, setPaymentInstructionsMd] = useState('');
  const [nearDefaultRail, setNearDefaultRail] = useState('base');
  const [insuranceRatePct, setInsuranceRatePct] = useState('1.27');
  const [saveMsg, setSaveMsg] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setSaveMsg('');
    setCode(cs?.code ?? '');
    setPublished(cs?.published ?? false);
    setDescriptionMd(cs?.description_md ?? '');
    setPaymentInstructionsMd(cs?.payment_instructions_md ?? '');
    setNearDefaultRail(cs?.near_default_rail ?? 'base');
    setInsuranceRatePct(cs ? String(Number(cs.insurance_rate_pct)) : '1.27');
  }, [groupBuyId, cs?.group_buy_id, cs?.code, cs?.published, cs?.description_md, cs?.payment_instructions_md, cs?.near_default_rail, cs?.insurance_rate_pct]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasOrders = useMemo(() => !!stats && Number(stats.unpaid) + Number(stats.payment_submitted) + Number(stats.paid) + Number(stats.cancelled) > 0, [stats]);
  const codeOk = CODE_RE.test(code.trim().toUpperCase());
  const activeRails = useMemo(() => new Set(options.filter(o => o.active).map(o => o.rail)), [options]);

  const save = async () => {
    if (groupBuyId == null) return;
    setSaveMsg('');
    if (!codeOk) { setSaveMsg('Code must be 2–8 letters or digits (it prefixes every order number, e.g. 2026-MB6-014).'); return; }
    if (published && activeRails.size === 0) { setSaveMsg('Add at least one active payment option before publishing — members would have nothing to pay on.'); return; }
    setSaving(true);
    try {
      const res = await doUpsert({
        group_buy_id: groupBuyId,
        code: code.trim().toUpperCase(),
        published: String(published),
        description_md: descriptionMd,
        payment_instructions_md: paymentInstructionsMd,
        near_default_rail: nearDefaultRail === 'none' ? '' : nearDefaultRail,
        insurance_rate_pct: insuranceRatePct.trim(),
      }) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      if (!touched) {
        setSaveMsg(hasOrders ? 'Refused: the code cannot change once orders carry it.' : 'Refused: check the code (2–8 letters or digits).');
      } else {
        setSaveMsg(published ? 'Saved — the campaign is live on the storefront.' : 'Saved (not published).');
        reloadCs(); reloadGroupBuys(); reloadStats();
      }
    } catch (e: unknown) {
      setSaveMsg(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // new payment option
  const [optRail, setOptRail] = useState('eth');
  const [optToken, setOptToken] = useState('USDC');
  const [optAddress, setOptAddress] = useState('');
  const [optLabel, setOptLabel] = useState('');
  const [optMsg, setOptMsg] = useState('');
  useEffect(() => { setOptToken(optRail === 'cash' ? 'ZELLE' : 'USDC'); }, [optRail]);

  const addOption = async () => {
    if (groupBuyId == null || !cs) return;
    setOptMsg('');
    try {
      const res = await doAddOpt({ group_buy_id: groupBuyId, rail: optRail, token: optToken, address: optAddress, label: optLabel, sort: String(options.length) }) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      if (!touched) {
        setOptMsg(optRail === 'cash' ? 'Refused: enter the handle members pay (email, phone or @username) and a method.' : `Refused: that is not a valid ${RAIL_LABEL[optRail]} address.`);
        return;
      }
      setOptAddress(''); setOptLabel(''); setOptMsg('Added.');
      reloadOpts();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add';
      setOptMsg(/unique|duplicate/i.test(msg) ? 'That wallet/handle is already on this campaign (retire and re-add to change its label).' : msg);
    }
  };

  const toggleOption = async (o: OptionRow) => {
    if (groupBuyId == null) return;
    try {
      await doSetActive({ id: o.id, group_buy_id: groupBuyId, active: String(!o.active) });
      reloadOpts();
    } catch (e: unknown) {
      setOptMsg(e instanceof Error ? e.message : 'Failed to update');
    }
  };

  if (!enabled) return <div className="p-6 text-sm text-muted-foreground">Pick a campaign first.</div>;

  const storefrontUrl = `${STOREFRONT_ORIGIN}/group-buys/${groupBuyId}`;

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2 text-gradient">
          <Globe className="h-6 w-6 text-cyan-300" /> Storefront
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          How <span className="font-medium">{groupBuy?.name}</span> appears on p2collective.app. Members order there; their orders come back in through Import → Refresh from storefront.
          {groupBuy && groupBuy.status !== 'open' && (
            <span className="block text-amber-300 mt-0.5">Campaign status is <span className="font-mono">{groupBuy.status}</span> — members can see a published campaign, but only an <span className="font-mono">open</span> one takes orders.</span>
          )}
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center justify-between gap-3">
            <span>Publishing</span>
            {cs?.published && (
              <a href={storefrontUrl} target="_blank" rel="noreferrer" className="text-xs font-normal text-cyan-300 hover:underline flex items-center gap-1">
                {storefrontUrl} <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {csLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1">
              <Label htmlFor="sf-code">Code</Label>
              <Input id="sf-code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} maxLength={8} placeholder="MB6" className="font-mono" disabled={hasOrders} />
              <p className="text-xs text-muted-foreground">{hasOrders ? 'Frozen — orders carry it.' : 'Prefixes order numbers: 2026-CODE-001.'}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sf-desc">Description (members see this under the campaign name)</Label>
              <Textarea id="sf-desc" value={descriptionMd} onChange={e => setDescriptionMd(e.target.value)} rows={3} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sf-pay">Payment instructions (shown on the campaign page above the lines)</Label>
            <Textarea id="sf-pay" value={paymentInstructionsMd} onChange={e => setPaymentInstructionsMd(e.target.value)} rows={3} placeholder="USDC or USDT on Ethereum, Solana or Base. Cash by Zelle, Venmo or PayPal adds the processor fee." />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>NEAR Intents settles to</Label>
              <Select value={nearDefaultRail} onValueChange={setNearDefaultRail}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="eth">Ethereum USDC</SelectItem>
                  <SelectItem value="sol">Solana USDC</SelectItem>
                  <SelectItem value="base">Base USDC</SelectItem>
                  <SelectItem value="none">Not offered</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sf-ins">Insurance rate (% of kits)</Label>
              <Input id="sf-ins" value={insuranceRatePct} onChange={e => setInsuranceRatePct(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" className="font-mono" />
              <p className="text-xs text-muted-foreground">Shippo is $1.27 per $100.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="sf-pub">Published</Label>
              <div className="flex items-center gap-3 h-9">
                <Switch id="sf-pub" checked={published} onCheckedChange={setPublished} />
                <span className="text-sm text-muted-foreground">{published ? 'Visible to signed-in members' : 'Hidden'}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={save} disabled={saving || !codeOk}>{saving ? 'Saving…' : cs ? 'Save' : 'Set up storefront'}</Button>
            {saveMsg && <span className={`text-sm ${/refused|failed|must|add at least/i.test(saveMsg) ? 'text-rose-400' : 'text-emerald-300'}`}>{saveMsg}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Payment options</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Wallets and handles members may pay on. Never edit an address in place — retire it and add the new one, so every order keeps pointing at what it was told to pay. Retired options vanish from unpaid orders and the storefront refuses new claims against them.
          </p>
          {!cs && <p className="text-sm text-amber-300">Set up the storefront (above) before adding payment options.</p>}
          {options.length > 0 && (
            <div className="border rounded overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Rail</TableHead>
                    <TableHead>Token / method</TableHead>
                    <TableHead>Address / handle</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead>Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {options.map(o => (
                    <TableRow key={o.id} className={o.active ? '' : 'opacity-60'}>
                      <TableCell>{RAIL_LABEL[o.rail] ?? o.rail}</TableCell>
                      <TableCell className="font-mono text-xs">{o.token}</TableCell>
                      <TableCell className="font-mono text-xs max-w-[260px] truncate" title={o.address}>{o.address}</TableCell>
                      <TableCell>{o.label}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{o.orders_using}</TableCell>
                      <TableCell><Switch checked={o.active} onCheckedChange={() => toggleOption(o)} aria-label={o.active ? 'Retire' : 'Reinstate'} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-[8rem_8rem_1fr_10rem_auto] items-end">
            <div className="space-y-1">
              <Label>Rail</Label>
              <Select value={optRail} onValueChange={setOptRail}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="eth">Ethereum</SelectItem>
                  <SelectItem value="sol">Solana</SelectItem>
                  <SelectItem value="base">Base</SelectItem>
                  <SelectItem value="cash">Cash</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="opt-token">{optRail === 'cash' ? 'Method' : 'Token'}</Label>
              {optRail === 'cash' ? (
                <Select value={optToken} onValueChange={setOptToken}>
                  <SelectTrigger id="opt-token"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ZELLE">Zelle</SelectItem>
                    <SelectItem value="VENMO">Venmo</SelectItem>
                    <SelectItem value="PAYPAL">PayPal</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input id="opt-token" value={optToken} onChange={e => setOptToken(e.target.value.toUpperCase())} className="font-mono" placeholder="USDC" />
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="opt-address">{optRail === 'cash' ? 'Handle (email, phone or @name)' : 'Wallet address'}</Label>
              <Input id="opt-address" value={optAddress} onChange={e => setOptAddress(e.target.value.trim())} className="font-mono" placeholder={optRail === 'sol' ? 'osS6…' : optRail === 'cash' ? 'pay@…' : '0x…'} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="opt-label">Label (optional)</Label>
              <Input id="opt-label" value={optLabel} onChange={e => setOptLabel(e.target.value)} placeholder="Main wallet" />
            </div>
            <Button onClick={addOption} disabled={!cs || !optAddress || !optToken}>Add</Button>
          </div>
          {optMsg && <p className={`text-sm ${/refused|failed|already/i.test(optMsg) ? 'text-rose-400' : 'text-emerald-300'}`}>{optMsg}</p>}
        </CardContent>
      </Card>

      {cs && stats && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Storefront orders</CardTitle></CardHeader>
          <CardContent className="text-sm space-y-1">
            <p>
              <span className="font-mono">{stats.unpaid}</span> unpaid · <span className="font-mono">{stats.payment_submitted}</span> payment submitted · <span className="font-mono">{stats.paid}</span> paid · <span className="font-mono">{stats.cancelled}</span> cancelled
              {stats.last_placed_at && <span className="text-muted-foreground"> · last placed {new Date(stats.last_placed_at).toLocaleString()}</span>}
            </p>
            {Number(stats.number_collisions) > 0 && (
              <p className="text-rose-400">
                {stats.number_collisions} storefront order number(s) coincide with ordering-app orders in this campaign — the import refuses them. This should be impossible (the sequence starts above every existing number); tell the organizers before importing.
              </p>
            )}
            {Number(stats.not_imported) > 0 ? (
              <p className="text-amber-300">
                {stats.not_imported} not yet imported here — <Link to="/import" className="text-cyan-300 hover:underline">Import → Refresh from storefront</Link> brings them into demand and reconciliation.
              </p>
            ) : (
              <p className="text-muted-foreground">Every live storefront order is imported.</p>
            )}
            <p className="text-xs text-muted-foreground">Next order number: 2026-{cs.code}-{String(cs.next_order_seq).padStart(3, '0')}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
