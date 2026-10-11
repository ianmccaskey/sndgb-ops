import React, { useEffect, useState } from 'react';
import { useLoadAction, useMutateAction } from '@uibakery/data';
import listStorefrontPolls from '@/actions/storefront/listStorefrontPolls';
import createStorefrontPoll from '@/actions/storefront/createStorefrontPoll';
import updateStorefrontPoll from '@/actions/storefront/updateStorefrontPoll';
import openStorefrontPoll from '@/actions/storefront/openStorefrontPoll';
import closeStorefrontPoll from '@/actions/storefront/closeStorefrontPoll';
import listStorefrontPollOptions from '@/actions/storefront/listStorefrontPollOptions';
import addStorefrontPollOption from '@/actions/storefront/addStorefrontPollOption';
import removeStorefrontPollOption from '@/actions/storefront/removeStorefrontPollOption';
import setStorefrontPollOptionSort from '@/actions/storefront/setStorefrontPollOptionSort';
import listStorefrontPollComments from '@/actions/storefront/listStorefrontPollComments';
import { useApp } from '@/app/AppContext';
import { rows } from '@/lib/rows';
import { fmtDateTime } from '@/lib/fmt';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Vote, ArrowUp, ArrowDown, Plus } from 'lucide-react';

/**
 * Member polls on p2collective.app (storefront.polls). Not tied to the
 * campaign in the header. A poll is created as a draft, opened (needs two
 * options), and closed — closing is final and a closed poll is read-only.
 * Every write is one row and audited; settings saves are version-checked.
 * Results here are always visible to organizers; member identity is only
 * ever the short form of the Neon Auth user id.
 */

type PollRow = {
  id: number;
  title: string;
  description_md: string | null;
  status: 'draft' | 'open' | 'closed' | string;
  opens_at: string | null;
  closes_at: string | null;
  max_choices: number;
  hide_results_until_close: boolean;
  allow_comments: boolean;
  created_by: string | null;
  created_at: string;
  /** opaque updated_at token handed back on save */
  version: string;
  option_count: string;
  vote_count: string;
  comment_count: string;
  /** the most options any one cast vote holds — max_choices cannot drop below it */
  max_choices_used: string;
};
type OptionRow = { id: number; poll_id: number; label: string; sort: number; votes: string };
type CommentRow = { id: number; poll_id: number; member: string; comment: string; created_at: string; choices: string | null };

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-400/10 text-slate-300',
  open: 'bg-emerald-400/10 text-emerald-300',
  closed: 'bg-amber-400/10 text-amber-300',
};

function PollStatus({ status }: { status: string }) {
  return <Badge variant="outline" className={`${STATUS_STYLE[status] ?? ''} border-0`}>{status}</Badge>;
}

/** timestamptz → the value a datetime-local input shows (local time, minutes). */
function toLocalInput(v: string | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** datetime-local value (local time) → ISO with zone, which the actions require. */
function toIso(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

type Form = { title: string; description: string; maxChoices: string; hideResults: boolean; allowComments: boolean; opensAt: string; closesAt: string };
const NEW_FORM: Form = { title: '', description: '', maxChoices: '1', hideResults: false, allowComments: true, opensAt: '', closesAt: '' };

const OK_MSG = /^(Poll created|Saved|Option added|Option removed|Order saved|Poll opened|Poll closed)\b/;

export function PollsPage() {
  const { userName } = useApp();

  const [rawPolls, pollsLoading, pollsError, reloadPolls] = useLoadAction(listStorefrontPolls, [], {});
  const polls = rows<PollRow>(rawPolls);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const selected = selectedId == null ? null : polls.find(p => Number(p.id) === selectedId) ?? null;
  const optsEnabled = selectedId != null;

  const [rawOpts, optsLoading, , reloadOpts] = useLoadAction(listStorefrontPollOptions, [selectedId], { poll_id: selectedId }, { enabled: optsEnabled });
  // a previous poll's rows can linger while the next one loads
  const options = rows<OptionRow>(rawOpts).filter(o => Number(o.poll_id) === selectedId);
  const [rawComments, commentsLoading, , reloadComments] = useLoadAction(listStorefrontPollComments, [selectedId], { poll_id: selectedId }, { enabled: optsEnabled });
  // same guard as options: a previous poll's comments can linger while the next poll's load
  const comments = rows<CommentRow>(rawComments).filter(c => Number(c.poll_id) === selectedId);

  const [doCreate] = useMutateAction(createStorefrontPoll);
  const [doUpdate] = useMutateAction(updateStorefrontPoll);
  const [doOpen] = useMutateAction(openStorefrontPoll);
  const [doClose] = useMutateAction(closeStorefrontPoll);
  const [doAddOpt] = useMutateAction(addStorefrontPollOption);
  const [doRemoveOpt] = useMutateAction(removeStorefrontPollOption);
  const [doSort] = useMutateAction(setStorefrontPollOptionSort);

  const [form, setForm] = useState<Form>(NEW_FORM);
  const [formMsg, setFormMsg] = useState('');
  const [optLabel, setOptLabel] = useState('');
  const [optMsg, setOptMsg] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [confirm, setConfirm] = useState<'open' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);

  // the form mirrors the stored poll; re-seeded when another poll is picked
  // or this one's stored row changes (save, open, close)
  useEffect(() => {
    if (creating || !selected) return;
    setForm({
      title: selected.title,
      description: selected.description_md ?? '',
      maxChoices: String(selected.max_choices),
      hideResults: !!selected.hide_results_until_close,
      allowComments: !!selected.allow_comments,
      opensAt: toLocalInput(selected.opens_at),
      closesAt: toLocalInput(selected.closes_at),
    });
  }, [creating, selected?.id, selected?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (id: number) => {
    setSelectedId(id); setCreating(false); setConfirm(null);
    setFormMsg(''); setOptMsg(''); setStatusMsg(''); setOptLabel('');
  };
  const startCreate = () => {
    setCreating(true); setSelectedId(null); setConfirm(null); setForm(NEW_FORM);
    setFormMsg(''); setOptMsg(''); setStatusMsg(''); setOptLabel('');
  };

  const reloadAll = () => { reloadPolls(); if (selectedId != null) { reloadOpts(); reloadComments(); } };

  const readOnly = !creating && selected?.status === 'closed';
  const votes = Number(selected?.vote_count ?? 0);
  const maxUsed = Number(selected?.max_choices_used ?? 0);

  const formProblem = (): string | null => {
    const title = form.title.trim();
    if (!title) return 'Give the poll a title.';
    if (title.length > 200) return 'Keep the title to 200 characters.';
    const opens = toIso(form.opensAt);
    const closes = toIso(form.closesAt);
    if (form.opensAt && !opens) return 'Opens at is not a valid time.';
    if (form.closesAt && !closes) return 'Closes at is not a valid time.';
    const closesUnchanged = !!selected && !creating && form.closesAt === toLocalInput(selected.closes_at);
    if (closes && !closesUnchanged && new Date(closes).getTime() <= Date.now()) return 'Closes at must be in the future.';
    if (opens && closes && new Date(closes).getTime() <= new Date(opens).getTime()) return 'Closes at must be after opens at.';
    if (!creating && Number(form.maxChoices) < maxUsed) return `A member already picked ${maxUsed} options — max choices cannot go below ${maxUsed}.`;
    return null;
  };

  const saveSettings = async () => {
    const problem = formProblem();
    if (problem) { setFormMsg(problem); return; }
    setBusy(true); setFormMsg('');
    const fields = {
      title: form.title.trim(),
      description_md: form.description.trim(),
      max_choices: form.maxChoices,
      hide_results_until_close: String(form.hideResults),
      allow_comments: String(form.allowComments),
      opens_at: toIso(form.opensAt),
      closes_at: toIso(form.closesAt),
      actor: userName,
    };
    try {
      if (creating) {
        const res = await doCreate(fields) as { id: number }[] | null;
        const created = Array.isArray(res) ? res.find(r => r && r.id != null) : null;
        if (!created) { setFormMsg('Refused: check the title, max choices (1–10) and times — closing must be in the future and after opening.'); return; }
        setCreating(false);
        setSelectedId(Number(created.id));
        setFormMsg('Poll created as a draft. Add at least two options, then open it.');
        reloadPolls();
      } else if (selected) {
        const res = await doUpdate({ ...fields, id: selected.id, expected_version: selected.version }) as unknown[] | null;
        const touched = Array.isArray(res) ? res.length > 0 : !!res;
        if (!touched) {
          setFormMsg('Refused: this poll changed since you loaded it (another admin or tab, or it was opened or closed). Reload the page and reapply your edits.');
          return;
        }
        setFormMsg('Saved.');
        reloadPolls();
      }
    } catch (e: unknown) {
      setFormMsg(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  const addOption = async () => {
    if (!selected) return;
    const label = optLabel.trim();
    setOptMsg('');
    if (!label) return;
    if (label.length > 200) { setOptMsg('Keep an option to 200 characters.'); return; }
    if (options.some(o => o.label.trim().toLowerCase() === label.toLowerCase())) { setOptMsg('The poll already has that option.'); return; }
    setBusy(true);
    try {
      const res = await doAddOpt({ poll_id: selected.id, label, actor: userName }) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      if (!touched) setOptMsg('Refused: the poll is closed, or already has that option. Reloaded.');
      else { setOptLabel(''); setOptMsg('Option added.'); }
      reloadOpts(); reloadPolls();
    } catch (e: unknown) {
      setOptMsg(e instanceof Error ? e.message : 'Failed to add');
    } finally {
      setBusy(false);
    }
  };

  const removeOption = async (o: OptionRow) => {
    if (!selected) return;
    setOptMsg(''); setBusy(true);
    try {
      const res = await doRemoveOpt({ id: o.id, poll_id: selected.id, actor: userName }) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      setOptMsg(touched ? 'Option removed.' : 'Refused: a member voted for it, an open poll keeps at least two options, or the poll is closed. Reloaded.');
      reloadOpts(); reloadPolls();
    } catch (e: unknown) {
      setOptMsg(e instanceof Error ? e.message : 'Failed to remove');
    } finally {
      setBusy(false);
    }
  };

  // Reorder = renumber the list 0..n-1 and write each option whose position
  // changed, one row per call (ties sort by id, so a partial run still lists
  // every option once and can simply be retried).
  const move = async (index: number, dir: -1 | 1) => {
    if (!selected) return;
    const j = index + dir;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    [next[index], next[j]] = [next[j], next[index]];
    setOptMsg(''); setBusy(true);
    try {
      for (let i = 0; i < next.length; i++) {
        if (Number(next[i].sort) === i) continue;
        const res = await doSort({ id: next[i].id, poll_id: selected.id, sort: String(i), actor: userName }) as unknown[] | null;
        const touched = Array.isArray(res) ? res.length > 0 : !!res;
        if (!touched) { setOptMsg('Refused: the poll was closed or the option removed. Reloaded.'); break; }
      }
      setOptMsg(m => m || 'Order saved.');
    } catch (e: unknown) {
      setOptMsg(e instanceof Error ? e.message : 'Failed to reorder');
    } finally {
      setBusy(false);
      reloadOpts();
    }
  };

  const transition = async (to: 'open' | 'close') => {
    if (!selected) return;
    setStatusMsg(''); setBusy(true);
    try {
      const res = (to === 'open'
        ? await doOpen({ id: selected.id, actor: userName })
        : await doClose({ id: selected.id, actor: userName })) as unknown[] | null;
      const touched = Array.isArray(res) ? res.length > 0 : !!res;
      if (!touched) {
        setStatusMsg(to === 'open'
          ? 'Refused: opening needs a draft poll with at least two options and a closing time still ahead. Reloaded.'
          : 'Refused: only an open poll can be closed. Reloaded.');
      } else {
        setStatusMsg(to === 'open' ? 'Poll opened — members can vote.' : 'Poll closed. It is now read-only.');
      }
      reloadAll();
    } catch (e: unknown) {
      setStatusMsg(e instanceof Error ? e.message : 'Failed to update the poll');
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const voters = votes;
  const closesPast = !!selected?.closes_at && new Date(selected.closes_at).getTime() <= Date.now();
  const openBlocker = !selected ? null
    : options.length < 2 ? 'Add at least two options before opening.'
    : closesPast ? 'Its closing time has passed — move "Closes at" later and save first.'
    : null;

  const msgClass = (m: string) => (OK_MSG.test(m) ? 'text-emerald-300' : 'text-rose-400');

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-5xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2 text-gradient">
            <Vote className="h-6 w-6 text-cyan-300" /> Polls
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Member polls on p2collective.app — not tied to the campaign in the header. Draft → open → closed: opening needs two options, and closing is final. Organizers always see results here; "hide results until close" only applies to members.
          </p>
        </div>
        <Button onClick={startCreate} disabled={busy || creating}><Plus /> New poll</Button>
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">All polls</CardTitle></CardHeader>
        <CardContent>
          {pollsError && <p className="text-sm text-rose-400">Could not load polls: {pollsError.message}</p>}
          {pollsLoading && polls.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!pollsLoading && !pollsError && polls.length === 0 && <p className="text-sm text-muted-foreground">No polls yet. Start one with New poll.</p>}
          {polls.length > 0 && (
            <div className="border rounded overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Options</TableHead>
                    <TableHead className="text-right">Votes</TableHead>
                    <TableHead>Opens</TableHead>
                    <TableHead>Closes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {polls.map(p => {
                    const isSel = Number(p.id) === selectedId;
                    return (
                      <TableRow key={p.id} className={`cursor-pointer ${isSel ? 'bg-white/5' : ''}`} onClick={() => pick(Number(p.id))}>
                        <TableCell className="font-medium max-w-[280px] truncate">
                          <button type="button" className="text-left hover:underline truncate max-w-full" onClick={e => { e.stopPropagation(); pick(Number(p.id)); }}>{p.title}</button>
                        </TableCell>
                        <TableCell><PollStatus status={p.status} /></TableCell>
                        <TableCell className="text-right font-mono text-xs">{p.option_count}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{p.vote_count}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{p.opens_at ? fmtDateTime(p.opens_at) : 'When opened'}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{p.closes_at ? fmtDateTime(p.closes_at) : 'When closed'}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {(creating || selectedId != null) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 flex-wrap">
              {creating ? 'New poll' : selected ? <>{selected.title} <PollStatus status={selected.status} /></> : 'Loading…'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {readOnly && selected ? (
              <div className="text-sm space-y-1">
                <p className="text-amber-300">Closed — this poll is read-only.</p>
                {selected.description_md && <p className="whitespace-pre-wrap text-muted-foreground">{selected.description_md}</p>}
                <p className="text-muted-foreground">
                  Up to {selected.max_choices} choice(s) · results {selected.hide_results_until_close ? 'were hidden from members until close' : 'were visible to members while open'} · comments {selected.allow_comments ? 'allowed' : 'off'}
                  {selected.opens_at ? ` · opening time ${fmtDateTime(selected.opens_at)}` : ''}{selected.closes_at ? ` · closing time ${fmtDateTime(selected.closes_at)}` : ''}
                </p>
              </div>
            ) : (creating || selected) && (
              <div className="space-y-3">
                <div className="space-y-1">
                  <Label htmlFor="poll-title">Title</Label>
                  <Input id="poll-title" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} maxLength={200} placeholder="What should the next buy carry?" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="poll-desc">Description (members see this above the options)</Label>
                  <Textarea id="poll-desc" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} rows={3} />
                </div>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label>Max choices per member</Label>
                    <Select value={form.maxChoices} onValueChange={v => setForm({ ...form, maxChoices: v })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Array.from({ length: 10 }, (_, i) => String(i + 1)).map(n => (
                          <SelectItem key={n} value={n} disabled={!creating && Number(n) < maxUsed}>{n}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="poll-opens">Opens at (optional)</Label>
                    <Input id="poll-opens" type="datetime-local" value={form.opensAt} onChange={e => setForm({ ...form, opensAt: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="poll-closes">Closes at (optional)</Label>
                    <Input id="poll-closes" type="datetime-local" value={form.closesAt} onChange={e => setForm({ ...form, closesAt: e.target.value })} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={form.hideResults} onCheckedChange={v => setForm({ ...form, hideResults: v })} aria-label="Hide results from members until close" />
                    Hide results from members until close
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <Switch checked={form.allowComments} onCheckedChange={v => setForm({ ...form, allowComments: v })} aria-label="Members may leave a comment" />
                    Members may leave a comment
                  </label>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <Button onClick={saveSettings} disabled={busy}>{busy ? 'Saving…' : creating ? 'Create draft' : 'Save settings'}</Button>
                  {creating && <Button variant="outline" onClick={() => { setCreating(false); setFormMsg(''); }} disabled={busy}>Cancel</Button>}
                  {formMsg && <span className={`text-sm ${msgClass(formMsg)}`}>{formMsg}</span>}
                </div>
              </div>
            )}

            {!creating && selected && (
              <div className="border-t pt-3 space-y-2">
                <p className="text-sm font-semibold">Options</p>
                {optsLoading && options.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
                {!optsLoading && options.length === 0 && <p className="text-sm text-muted-foreground">No options yet.</p>}
                {options.length > 0 && (
                  <ol className="border rounded divide-y">
                    {options.map((o, i) => {
                      const voted = Number(o.votes) > 0;
                      const lastTwo = selected.status === 'open' && options.length <= 2;
                      const removeHint = voted ? 'voted for — kept' : lastTwo ? 'an open poll keeps two' : null;
                      return (
                        <li key={o.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                          <span className="w-6 text-xs text-muted-foreground font-mono">{i + 1}.</span>
                          <span className="flex-1 min-w-0 truncate" title={o.label}>{o.label}</span>
                          <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">{o.votes} vote(s)</span>
                          {!readOnly && (
                            <>
                              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Move ${o.label} up`} disabled={busy || i === 0} onClick={() => move(i, -1)}><ArrowUp /></Button>
                              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Move ${o.label} down`} disabled={busy || i === options.length - 1} onClick={() => move(i, 1)}><ArrowDown /></Button>
                              {removeHint ? (
                                <span className="text-xs text-muted-foreground w-28 text-right">{removeHint}</span>
                              ) : (
                                <Button size="sm" variant="ghost" className="h-7 text-xs text-rose-400 w-28" disabled={busy} onClick={() => removeOption(o)}>Remove</Button>
                              )}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
                {!readOnly && (
                  <div className="space-y-1">
                    <div className="flex gap-2">
                      <Input aria-label="New option" value={optLabel} onChange={e => setOptLabel(e.target.value)} maxLength={200} placeholder="Add an option"
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }} />
                      <Button variant="outline" onClick={addOption} disabled={busy || !optLabel.trim()}>Add</Button>
                    </div>
                    {selected.status === 'open' && votes > 0 && (
                      <p className="text-xs text-amber-300">{votes} member(s) have already voted — they will not have seen an option added now.</p>
                    )}
                  </div>
                )}
                {optMsg && <p className={`text-sm ${msgClass(optMsg)}`}>{optMsg}</p>}
              </div>
            )}

            {!creating && selected && selected.status !== 'closed' && (
              <div className="border-t pt-3 space-y-2">
                {confirm === 'open' ? (
                  <div className="rounded border border-amber-400/40 bg-amber-400/5 p-3 text-sm space-y-2">
                    <p className="font-semibold text-amber-200">Open "{selected.title}" to members?</p>
                    <p>
                      Members can vote on {options.length} options, up to {selected.max_choices} each
                      {selected.opens_at ? `, from ${fmtDateTime(selected.opens_at)}` : ''}{selected.closes_at ? ` until ${fmtDateTime(selected.closes_at)}` : ' until you close it'}.
                      An option someone votes for can no longer be removed.
                    </p>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => transition('open')}>{busy ? 'Opening…' : 'Open poll'}</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
                    </div>
                  </div>
                ) : confirm === 'close' ? (
                  <div className="rounded border border-amber-400/40 bg-amber-400/5 p-3 text-sm space-y-2">
                    <p className="font-semibold text-amber-200">Close "{selected.title}"?</p>
                    <p>Voting stops now with {votes} vote(s). Closing is final: the poll cannot be reopened or edited afterwards.</p>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={busy} onClick={() => transition('close')}>{busy ? 'Closing…' : 'Close poll for good'}</Button>
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(null)}>Keep open</Button>
                    </div>
                  </div>
                ) : selected.status === 'draft' ? (
                  <div className="flex items-center gap-3 flex-wrap">
                    <Button variant="outline" disabled={busy || !!openBlocker} onClick={() => { setStatusMsg(''); setConfirm('open'); }}>Open to members</Button>
                    <span className="text-xs text-muted-foreground">{openBlocker ?? 'Hidden from members while a draft.'}</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm text-emerald-300">Open — members can vote.</span>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => { setStatusMsg(''); setConfirm('close'); }}>Close poll</Button>
                  </div>
                )}
                {statusMsg && <p className={`text-sm ${msgClass(statusMsg)}`}>{statusMsg}</p>}
              </div>
            )}
            {!creating && selected && selected.status === 'closed' && statusMsg && <p className={`text-sm ${msgClass(statusMsg)}`}>{statusMsg}</p>}
          </CardContent>
        </Card>
      )}

      {!creating && selected && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center justify-between gap-3">
              <span>Results</span>
              <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy} onClick={reloadAll}>Refresh</Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {voters} member(s) voted{selected.max_choices > 1 ? `, each picking up to ${selected.max_choices}` : ''}. Percentages are of voters.
              {selected.hide_results_until_close && selected.status !== 'closed' ? ' Members cannot see these until the poll closes.' : ''}
            </p>
            {options.length === 0 ? (
              <p className="text-sm text-muted-foreground">No options yet.</p>
            ) : (
              <ul className="space-y-2">
                {options.map(o => {
                  const n = Number(o.votes);
                  const pct = voters > 0 ? Math.round((n / voters) * 100) : 0;
                  return (
                    <li key={o.id} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate" title={o.label}>{o.label}</span>
                        <span className="font-mono text-xs whitespace-nowrap">{n} · {pct}%</span>
                      </div>
                      <div className="h-2 rounded bg-white/5 overflow-hidden" aria-hidden="true">
                        <div className="h-full bg-cyan-400/70" style={{ width: `${pct}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="border-t pt-3 space-y-2">
              <p className="text-sm font-semibold">Comments ({comments.length})</p>
              {!selected.allow_comments && <p className="text-xs text-muted-foreground">Comments are off for this poll{comments.length > 0 ? '; these were left before they were turned off' : ''}.</p>}
              {commentsLoading && comments.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
              {!commentsLoading && comments.length === 0 && selected.allow_comments && <p className="text-sm text-muted-foreground">No comments yet.</p>}
              {comments.length > 0 && (
                <ul className="divide-y border rounded">
                  {comments.map(c => (
                    <li key={c.id} className="px-3 py-2 text-sm space-y-0.5">
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono" title="Short form of the member's account id">{c.member}</span>
                        {c.choices ? ` · voted ${c.choices}` : ''} · {fmtDateTime(c.created_at)}
                      </p>
                      <p className="whitespace-pre-wrap break-words">{c.comment}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
