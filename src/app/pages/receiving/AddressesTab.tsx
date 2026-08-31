import React, { useState } from 'react';
import { useMutateAction } from '@uibakery/data';
import saveReceiveAddress from '@/actions/receiving/saveReceiveAddress';
import setAddressActive from '@/actions/receiving/setAddressActive';
import setDefaultShipFrom from '@/actions/receiving/setDefaultShipFrom';
import setTransferOrigin from '@/actions/receiving/setTransferOrigin';
import setDestinationActive from '@/actions/receiving/setDestinationActive';
import saveDestination from '@/actions/receiving/saveDestination';
import { useApp } from '@/app/AppContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { RxAddress } from './shared';

type Draft = { label: string; name: string; street1: string; street2: string; city: string; state: string; zip: string; phone: string; email: string };
const EMPTY: Draft = { label: '', name: '', street1: '', street2: '', city: '', state: '', zip: '', phone: '', email: '' };

function AddressForm({ title, hint, onSave, msg }: {
  title: string; hint: string;
  onSave: (d: Draft) => Promise<boolean>;
  msg: string;
}) {
  const [d, setD] = useState<Draft>(EMPTY);
  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => setD(x => ({ ...x, [k]: e.target.value }));
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          <Input placeholder="Label (short name)" value={d.label} onChange={set('label')} className="h-9" />
          <Input placeholder="Recipient name" value={d.name} onChange={set('name')} className="h-9 col-span-1 sm:col-span-2" />
          <Input placeholder="Street" value={d.street1} onChange={set('street1')} className="h-9 col-span-2" />
          <Input placeholder="Apt / unit" value={d.street2} onChange={set('street2')} className="h-9" />
          <Input placeholder="City" value={d.city} onChange={set('city')} className="h-9" />
          <Input placeholder="State" value={d.state} onChange={set('state')} className="h-9" />
          <Input placeholder="Zip" value={d.zip} onChange={set('zip')} className="h-9" />
          <Input placeholder="Phone (optional)" value={d.phone} onChange={set('phone')} className="h-9" />
          <Input placeholder="Email (optional)" value={d.email} onChange={set('email')} className="h-9 col-span-1 sm:col-span-2" />
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={async () => { if (await onSave(d)) setD(EMPTY); }}>Save</Button>
          {msg && <p className="text-xs text-red-600">{msg}</p>}
        </div>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

function AddressList({ title, items, onToggle, onMakeDefault, onSetOrigin }: {
  title: string; items: RxAddress[]; onToggle?: (a: RxAddress) => void;
  onMakeDefault?: (a: RxAddress) => void;
  onSetOrigin?: (a: RxAddress, originId: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {items.map(a => (
          <div key={a.id} className="flex items-start justify-between gap-2 border-b last:border-0 pb-2">
            <div className="min-w-0 text-sm">
              <div className="font-medium">
                {a.label}
                {a.is_default_ship_from && <span className="ml-1.5 rounded bg-violet-100 text-violet-900 text-[10px] font-semibold px-1.5 py-0.5 uppercase" title="The Ship dialog preselects this address">default ship-from</span>}
                {!a.active && <span className="ml-1 text-xs font-normal text-muted-foreground">(archived)</span>}
              </div>
              <div className="text-xs text-muted-foreground">
                {a.name} · {a.street1}{a.street2 ? `, ${a.street2}` : ''}, {a.city}, {a.state} {a.zip}
              </div>
              {onMakeDefault && !a.phone && a.active && (
                <div className="text-[11px] text-amber-700">No phone — Shippo refuses label purchases without a ship-from phone; update this label above with one.</div>
              )}
              {onSetOrigin && a.active && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground mt-0.5">
                  Transfers ship from:
                  <select className="border rounded px-1 py-0.5 text-[11px] bg-background"
                    value={a.transfer_origin_id == null ? '' : String(a.transfer_origin_id)}
                    disabled={items.some(m => Number(m.transfer_origin_id ?? 0) === Number(a.id))}
                    title={items.some(m => Number(m.transfer_origin_id ?? 0) === Number(a.id))
                      ? 'Other addresses route through this one — clear them first to re-point it'
                      : 'Where a transfer of stock received HERE ships from (its inventory counts at that origin)'}
                    onChange={e => onSetOrigin(a, e.target.value)}>
                    <option value="">itself</option>
                    {items.filter(o => o.active && o.transfer_origin_id == null && Number(o.id) !== Number(a.id)).map(o => (
                      <option key={o.id} value={String(o.id)}>{o.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <span className="flex gap-1 shrink-0">
              {onMakeDefault && a.active && !a.is_default_ship_from && (
                <Button size="sm" variant="ghost" className="h-7 text-xs" title="Make the Ship dialog preselect this address"
                  onClick={() => onMakeDefault(a)}>
                  Make default
                </Button>
              )}
              {onToggle && (
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onToggle(a)}>
                  {a.active ? 'Archive' : 'Restore'}
                </Button>
              )}
            </span>
          </div>
        ))}
        {items.length === 0 && <p className="text-xs text-muted-foreground">None yet.</p>}
      </CardContent>
    </Card>
  );
}

export function AddressesTab({ addresses, destinations, reloadAddresses, reloadDestinations }: {
  addresses: RxAddress[]; destinations: RxAddress[];
  reloadAddresses: () => void; reloadDestinations: () => void;
}) {
  const { userName } = useApp();
  const [doSaveAddress] = useMutateAction(saveReceiveAddress);
  const [doSetActive] = useMutateAction(setAddressActive);
  const [doSetDefault] = useMutateAction(setDefaultShipFrom);
  const [doSetOrigin] = useMutateAction(setTransferOrigin);
  const [doSetDestActive] = useMutateAction(setDestinationActive);
  const [doSaveDest] = useMutateAction(saveDestination);
  const [addrMsg, setAddrMsg] = useState('');
  const [destMsg, setDestMsg] = useState('');

  const save = (kind: 'address' | 'dest') => async (d: Draft): Promise<boolean> => {
    const setMsg = kind === 'address' ? setAddrMsg : setDestMsg;
    setMsg('');
    const doIt = kind === 'address' ? doSaveAddress : doSaveDest;
    try {
      const res = await doIt({
        label: d.label, name: d.name, street1: d.street1, street2: d.street2,
        city: d.city, state: d.state, zip: d.zip, country: 'US',
        phone: d.phone, email: d.email, actor: userName,
        // 'any': the manual form's semantic IS upsert-by-label — the
        // operator just typed this label deliberately
        expected_id: 'any',
      }) as unknown[] | null;
      if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
        setMsg('Not saved — label, recipient, street, city, state, and zip are required (Shippo needs a complete address). If this label is archived, Restore it first.');
        return false;
      }
      (kind === 'address' ? reloadAddresses : reloadDestinations)();
      return true;
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Failed to save');
      return false;
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <AddressForm title="Add / update receive address" msg={addrMsg} onSave={save('address')}
          hint="Saving an existing label updates that address. Receive addresses are the ship-from on transfer labels — every field Shippo needs is required." />
        <AddressList title="Receive addresses" items={addresses}
          onToggle={async a => {
            if (a.active && a.is_default_ship_from
              && !window.confirm(`"${a.label}" is the default ship-from — archiving releases the default, and the Ship dialog will stop preselecting an address until you pick a new one. Archive anyway?`)) return;
            await doSetActive({ id: a.id, active: !a.active, actor: userName });
            reloadAddresses();
          }}
          onMakeDefault={async a => {
            setAddrMsg('');
            try {
              const res = await doSetDefault({ address_id: a.id, actor: userName }) as unknown[] | null;
              if (!(Array.isArray(res) ? res.length > 0 : !!res)) setAddrMsg('Not set — the address must be active.');
            } catch (e: unknown) {
              setAddrMsg(e instanceof Error ? e.message : 'Failed to set the default ship-from');
            }
            reloadAddresses();
          }}
          onSetOrigin={async (a, originId) => {
            setAddrMsg('');
            try {
              const res = await doSetOrigin({ address_id: a.id, origin_id: originId, actor: userName }) as unknown[] | null;
              if (!(Array.isArray(res) ? res.length > 0 : !!res)) {
                setAddrMsg('Origin not changed — the target must be an active address with no origin of its own, and an address other rows route through cannot be re-pointed.');
              }
            } catch (e: unknown) {
              setAddrMsg(e instanceof Error ? e.message : 'Failed to set the transfer origin');
            }
            reloadAddresses();
          }} />
      </div>
      <div className="space-y-4">
        <AddressForm title="Add / update saved destination" msg={destMsg} onSave={save('dest')}
          hint="The address book for transfer destinations, so you don't retype them." />
        <AddressList title="Saved destinations" items={destinations}
          onToggle={async a => { await doSetDestActive({ id: a.id, active: !a.active, actor: userName }); reloadDestinations(); }} />
      </div>
    </div>
  );
}
