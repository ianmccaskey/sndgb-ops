import { useEffect, useRef } from 'react';

/**
 * Re-read a dialog's (or panel's) loads each time it opens.
 *
 * useLoadAction re-reads when its `params` or `enabled` change; its SECOND
 * argument is the value it returns while loading, not a dependency list. A
 * dialog that opens again on the same params would otherwise show what it
 * read last time. Pass what opens it — the same condition the loads use as
 * `enabled` (e.g. `open && !!sellerId`), or the id of what it shows when
 * moving straight from one to another is also an opening — and the loads'
 * reload functions. Each change to an open value (not null / undefined /
 * false / '') after mount runs every reload once; a dialog that mounts
 * already open is read by the loads themselves.
 */
export function useReloadOnOpen(open: unknown, ...reloads: Array<() => unknown>) {
  const last = useRef(open);
  useEffect(() => {
    const prev = last.current;
    last.current = open;
    const isOpen = open != null && open !== false && open !== '';
    if (isOpen && !Object.is(prev, open)) for (const reload of reloads) void reload();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}
