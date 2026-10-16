import React, { useEffect, useMemo, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import createManualOrder from '@/actions/orders/createManualOrder';
import nextManualOrderNumber from '@/actions/orders/nextManualOrderNumber';
import addLocalOrderItem from '@/actions/orders/addLocalOrderItem';
import listOrders from '@/actions/orders/listOrders';
import getOrder from '@/actions/orders/getOrder';
import listCampaignProducts from '@/actions/campaign/listCampaignProducts';
import { useApp } from '@/app/AppContext';
import { rows, firstRow } from '@/lib/rows';
import { fmtUSD } from '@/lib/fmt';
import { Field } from '@/components/Field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus, Trash2 } from 'lucide-react';

type CampaignProduct = { group_buy_product_id: number; sku_code: string; product_name: string; gb_price_usd: string; status: string };
type Line = { key: number; sku: string; qty: string };
type CreateResult = { id: number | null; order_number: string | null; refused: string | null };

const REFUSALS: Record<string, string> = {
  'storefront campaign': 'This campaign runs on the storefront — its orders come only from p2collective.app, so an order cannot be added here.',
  'bad number': 'The order number must be this campaign\'s manual shape (prefix + "-X" + three or more digits, e.g. 2026-MB5-X001). Use the suggested number.',
  'number taken': 'That order number is already registered (here or on the storefront). Use the suggested number.',
  'no customer name': 'Enter the customer\'s name.',
  'no such campaign': 'The selected campaign no longer exists — pick another in the header.',
};

/**
 * Add an order that exists ONLY in this app (no base44, no storefront):
 * createManualOrder writes the header, then every line goes in through the
 * same addLocalOrderItem the order sheet uses, one call per line. The order
 * is billed at the local items value; fees and payments are set on the
 * sheet afterwards, which opens on success.
 *
 * Partial success is shown, not hidden: if the header landed but a line was
 * refused, the dialog stays open naming the line, with a button to open
 * the order (the operator adds the line there or cancels the order).
 *
 * A LOST create response (the header committed, the reply never arrived —
 * the transport failure ImportRunner documents) is recovered, never
 * duplicated: every submit carries a per-open request token stored on the
 * header (raw_import.request_id); on a thrown create, the dialog looks the
 * typed number up in this campaign and resumes it ONLY if it carries this
 * token. An order holding the number under another token is another
 * admin's (both got the same suggestion and theirs won the registry): that
 * is a refused number, never a place to put these lines.
 */

const mintRequestId = (): string =>
  (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export function AddOrderDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (orderId: number) => void;
}) {
  const { groupBuyId, groupBuy, userName } = useApp();
  const [rawNext, nextLoading, , reloadNext] = useLoadAction(
    nextManualOrderNumber, [groupBuyId, open], { group_buy_id: groupBuyId }, { enabled: open && groupBuyId != null },
  );
  const [rawProducts] = useLoadAction(
    listCampaignProducts, [groupBuyId, open], { group_buy_id: groupBuyId }, { enabled: open && groupBuyId != null },
  );
  const [doCreate] = useMutateAction(createManualOrder);
  const [doAddLine] = useMutateAction(addLocalOrderItem);
  const [findOrders] = useMutateAction(listOrders);
  const [fetchOrder] = useMutateAction(getOrder);

  const products = useMemo(
    () => rows<CampaignProduct>(rawProducts).filter(p => p.status === 'active'),
    [rawProducts],
  );
  const suggested = firstRow<{ prefix: string; order_number: string }>(rawNext);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [discord, setDiscord] = useState('');
  const [phone, setPhone] = useState('');
  const [line1, setLine1] = useState('');
  const [line2, setLine2] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [rail, setRail] = useState('');
  const [number, setNumber] = useState('');
  const [numberTouched, setNumberTouched] = useState(false);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([{ key: 1, sku: '', qty: '1' }]);
  // one token per open: a retry after an ambiguous failure is the SAME
  // request, so it can find (and only find) its own committed header
  const [requestId, setRequestId] = useState(mintRequestId);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  // header written, some lines refused: keep the dialog open with the facts
  const [partial, setPartial] = useState<{ id: number; number: string; failed: string[] } | null>(null);

  // the suggested number is the default; an operator who edits it keeps their edit
  useEffect(() => {
    if (!numberTouched && suggested?.order_number) setNumber(suggested.order_number);
  }, [suggested?.order_number, numberTouched]);

  // a fresh dialog per open: nothing from the last order leaks into the next
  useEffect(() => {
    if (!open) return;
    setName(''); setEmail(''); setDiscord(''); setPhone('');
    setLine1(''); setLine2(''); setCity(''); setState(''); setZip('');
    setRail(''); setNumber(''); setNumberTouched(false); setNote('');
    setLines([{ key: 1, sku: '', qty: '1' }]);
    setRequestId(mintRequestId());
    setMsg(''); setFieldErr({}); setPartial(null); setSaving(false);
    reloadNext();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const priceOf = (sku: string) => Number(products.find(p => p.sku_code === sku)?.gb_price_usd || 0);
  const validLines = lines.filter(l => l.sku && /^\d+$/.test(l.qty.trim()) && Number(l.qty) > 0);
  const total = validLines.reduce((s, l) => s + priceOf(l.sku) * Number(l.qty), 0);

  const checkEmail = () => {
    const e = email.trim();
    setFieldErr(f => ({ ...f, email: e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? 'This email is missing an @ or a domain.' : '' }));
  };
  const checkState = () => {
    const s = state.trim();
    setFieldErr(f => ({ ...f, state: s && !/^[A-Za-z]{2}$/.test(s) ? 'Use the 2-letter state code (e.g. CA).' : '' }));
  };

  const validate = (): string => {
    if (!name.trim()) return 'Enter the customer\'s name.';
    if (fieldErr.email || fieldErr.state) return 'Fix the highlighted fields first.';
    if (!rail) return 'Pick the rail the customer will pay on — reconciliation keys on it.';
    if (!number.trim()) return 'The order number is still loading — wait a moment or type one.';
    if (lines.length === 0 || validLines.length === 0) return 'Add at least one item with a whole-kit quantity.';
    const dupe = new Set<string>();
    for (const l of lines) {
      if (!l.sku) return 'Every line needs a product (remove empty lines).';
      if (!/^\d+$/.test(l.qty.trim()) || !(Number(l.qty) > 0)) return `${l.sku}: quantity must be a whole number of kits (local lines cannot be split kits).`;
      if (dupe.has(l.sku)) return `${l.sku} is listed twice — one line per product (change the quantity instead).`;
      dupe.add(l.sku);
    }
    return '';
  };

  // the header exists (created now, or recovered after a lost reply): add
  // every line, then open the order — or stay open naming refused lines
  const addLinesAndOpen = async (orderId: number, orderNumber: string) => {
    if (groupBuyId == null) return;
    const failed: string[] = [];
    for (const l of validLines) {
      try {
        const lr = await doAddLine({ order_id: orderId, group_buy_id: groupBuyId, sku: l.sku, qty: l.qty.trim(), actor: userName }) as unknown[] | null;
        if (!(Array.isArray(lr) ? lr.length > 0 : !!lr)) failed.push(`${l.sku} × ${l.qty}`);
      } catch (e: unknown) {
        failed.push(`${l.sku} × ${l.qty} (${e instanceof Error ? e.message : 'failed'})`);
      }
    }
    if (failed.length > 0) {
      setPartial({ id: orderId, number: orderNumber, failed });
      return;
    }
    onCreated(orderId);
  };

  // did the create land even though its reply did not? Ours only if the
  // header carries THIS request's token; the same number under another
  // token is another admin's order that won the registry race
  const findCommittedHeader = async (orderNumber: string): Promise<{ id: number } | 'taken' | null> => {
    if (groupBuyId == null) return null;
    try {
      const res = await findOrders({ group_buy_id: groupBuyId, search: orderNumber, status: 'all', rail: 'all', recon: 'all' }) as unknown;
      const hit = rows<{ id: number; order_number: string }>(res).find(o => o.order_number === orderNumber);
      if (!hit) return null;
      const full = firstRow<{ raw_import: { source?: string; request_id?: string } | null }>(await fetchOrder({ order_id: hit.id }) as unknown);
      return full?.raw_import?.source === 'manual' && full.raw_import.request_id === requestId ? { id: Number(hit.id) } : 'taken';
    } catch {
      return null;
    }
  };

  const submit = async () => {
    if (groupBuyId == null) return;
    const err = validate();
    if (err) { setMsg(err); return; }
    const orderNumber = number.trim();
    setSaving(true); setMsg('');
    try {
      let res: unknown;
      try {
        res = await doCreate({
          group_buy_id: groupBuyId, order_number: orderNumber, payment_rail: rail,
          customer_name: name.trim(), email: email.trim(), discord: discord.trim(), phone: phone.trim(),
          address_line1: line1.trim(), address_line2: line2.trim(), city: city.trim(), state_code: state.trim(), postal_code: zip.trim(),
          customer_note: note.trim(), actor: userName, request_id: requestId,
        });
      } catch (e: unknown) {
        // ambiguous failure: the header may have committed with the reply
        // lost — recover it instead of letting a retry mint a second order
        const recovered = await findCommittedHeader(orderNumber);
        if (recovered === 'taken') {
          setMsg(REFUSALS['number taken']);
          setNumberTouched(false); reloadNext();
          return;
        }
        if (recovered != null) {
          setMsg('');
          await addLinesAndOpen(recovered.id, orderNumber);
          return;
        }
        // nothing found, or the recovery read failed too: the outcome is
        // unknown, so keep THIS number and token — a retry re-checks for
        // the committed header before anything else (below) and can never
        // mint a second order
        setMsg(`${e instanceof Error ? e.message : 'Failed to create the order'} — could not confirm whether it was created. Keep the same order number and try again.`);
        return;
      }
      const r = firstRow<CreateResult>(res);
      if (!r || r.id == null) {
        const why = r?.refused || '';
        if (why === 'number taken') {
          // a retry after an unconfirmed create: if the number is ours
          // (same token), resume that header instead of moving on
          const mine = await findCommittedHeader(orderNumber);
          if (mine != null && mine !== 'taken') {
            setMsg('');
            await addLinesAndOpen(mine.id, orderNumber);
            return;
          }
          if (mine == null) {
            setMsg('That order number is registered, but whether it is this order could not be confirmed. Keep the same number and try again.');
            return;
          }
        }
        setMsg(REFUSALS[why] || 'The order was not created — nothing was written.');
        if (why === 'number taken' || why === 'bad number') { setNumberTouched(false); reloadNext(); }
        return;
      }
      await addLinesAndOpen(Number(r.id), String(r.order_number || orderNumber));
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Failed to create the order');
    } finally {
      setSaving(false);
    }
  };

  const setLine = (key: number, patch: Partial<Line>) => setLines(ls => ls.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => setLines(ls => [...ls, { key: (ls[ls.length - 1]?.key || 0) + 1, sku: '', qty: '1' }]);
  const removeLine = (key: number) => setLines(ls => ls.filter(l => l.key !== key));

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !saving) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add order — {groupBuy?.name}</DialogTitle>
          <DialogDescription>
            An order that exists only in this app (not in the ordering app). It is billed at its items' value; set fees and record payments on the order after it opens.
          </DialogDescription>
        </DialogHeader>

        {partial ? (
          <div className="space-y-3">
            <div className="rounded-md border border-amber-400/40 bg-amber-400/10 p-3 text-sm">
              <p className="font-semibold text-amber-200">Order {partial.number} was created, but these lines were refused:</p>
              <ul className="list-disc ml-5 mt-1 text-amber-100">
                {partial.failed.map(f => <li key={f}>{f}</li>)}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">A line is refused when the product is not active in this campaign or the quantity is not a whole number of kits. Open the order to add the line there, or cancel the order from its admin section.</p>
            </div>
            <div className="flex justify-end">
              <Button onClick={() => onCreated(partial.id)}>Open {partial.number}</Button>
            </div>
          </div>
        ) : (
          <form className="space-y-5" onSubmit={e => { e.preventDefault(); submit(); }}>
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Customer</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Name">
                  <Input value={name} onChange={e => setName(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Email (optional)" hint={fieldErr.email || 'Matches an existing customer by email; otherwise by name.'}>
                  <Input type="email" inputMode="email" value={email} onChange={e => setEmail(e.target.value)} onBlur={checkEmail}
                    className={fieldErr.email ? 'border-rose-400' : ''} autoComplete="off" />
                </Field>
                <Field label="Discord (optional)">
                  <Input value={discord} onChange={e => setDiscord(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Phone (optional)">
                  <Input type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} autoComplete="off" />
                </Field>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Ship to (optional — needed before a label)</legend>
              <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
                <Field label="Address" className="sm:col-span-4">
                  <Input value={line1} onChange={e => setLine1(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Apt / unit" className="sm:col-span-2">
                  <Input value={line2} onChange={e => setLine2(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="City" className="sm:col-span-3">
                  <Input value={city} onChange={e => setCity(e.target.value)} autoComplete="off" />
                </Field>
                <Field label="State" className="sm:col-span-1" hint={fieldErr.state || undefined}>
                  <Input value={state} onChange={e => setState(e.target.value.toUpperCase())} onBlur={checkState} maxLength={2}
                    className={fieldErr.state ? 'border-rose-400' : ''} autoComplete="off" />
                </Field>
                <Field label="ZIP" className="sm:col-span-2">
                  <Input inputMode="numeric" value={zip} onChange={e => setZip(e.target.value)} autoComplete="off" />
                </Field>
              </div>
            </fieldset>

            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">Order</legend>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Order number" hint={suggested ? `Manual numbers for this campaign are ${suggested.prefix}-X###; the next free one is suggested.` : (nextLoading ? 'Finding the next free number…' : undefined)}>
                  <Input value={number} onChange={e => { setNumber(e.target.value.toUpperCase()); setNumberTouched(true); }} className="font-mono" autoComplete="off" />
                </Field>
                <Field label="Payment rail" hint="The wallet or method the customer will pay on.">
                  <Select value={rail} onValueChange={setRail}>
                    <SelectTrigger><SelectValue placeholder="Pick a rail" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="eth">eth</SelectItem>
                      <SelectItem value="sol">sol</SelectItem>
                      <SelectItem value="base">base</SelectItem>
                      <SelectItem value="cash">cash</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Customer note (optional)">
                <Textarea value={note} onChange={e => setNote(e.target.value)} rows={2} />
              </Field>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Items</legend>
              {products.length === 0 && (
                <p className="text-xs text-amber-300">This campaign has no active products — add products to it first.</p>
              )}
              {lines.map(l => (
                <div key={l.key} className="flex items-center gap-2">
                  <Select value={l.sku} onValueChange={v => setLine(l.key, { sku: v })}>
                    <SelectTrigger className="flex-1 min-w-0"><SelectValue placeholder="Pick a product" /></SelectTrigger>
                    <SelectContent>
                      {products.map(p => (
                        <SelectItem key={p.group_buy_product_id} value={p.sku_code}>
                          {p.sku_code} · {p.product_name} · {fmtUSD(p.gb_price_usd)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input inputMode="numeric" aria-label="Quantity (kits)" value={l.qty} onChange={e => setLine(l.key, { qty: e.target.value })} className="w-20" />
                  <span className="w-20 text-right text-sm tabular-nums text-muted-foreground">
                    {l.sku && /^\d+$/.test(l.qty.trim()) ? fmtUSD(priceOf(l.sku) * Number(l.qty)) : '—'}
                  </span>
                  <Button type="button" size="icon" variant="ghost" className="h-8 w-8" aria-label="Remove line" disabled={lines.length === 1} onClick={() => removeLine(l.key)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <Button type="button" size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={addLine} disabled={products.length === 0}>
                  <Plus className="h-3.5 w-3.5" /> Add line
                </Button>
                <p className="text-sm">Items total <span className="font-semibold tabular-nums">{fmtUSD(total)}</span> <span className="text-xs text-muted-foreground">(whole kits at campaign price; fees are set on the order)</span></p>
              </div>
            </fieldset>

            {msg && <p className="text-sm text-rose-400">{msg}</p>}

            <div className="flex items-center justify-end gap-2">
              <Button type="button" variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
              <Button type="submit" disabled={saving || products.length === 0}>{saving ? 'Creating…' : 'Create order'}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
