import { useCallback, useRef } from 'react';

/**
 * Returns the PREVIOUS reference whenever the new value is content-equal
 * (JSON), so referential identity only changes when data actually changes.
 *
 * Exists because runtime-provided hooks (useLoadAction/useUser) may return a
 * fresh array/object every render — anything memoized on those results, like
 * the app context value, would then rebuild on every render of the provider
 * and cascade a re-render through every consumer. Intended for SMALL values
 * (campaign list, settings map); do not feed it large result sets.
 */
export function useStableValue<T>(value: T): T {
  const ref = useRef<{ value: T; key: string } | null>(null);
  const key = JSON.stringify(value ?? null);
  if (ref.current == null || ref.current.key !== key) {
    ref.current = { value, key };
  }
  return ref.current.value;
}

/**
 * A referentially-stable wrapper around a possibly-unstable function (e.g.
 * a reload function returned by useLoadAction). Always invokes the latest.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}
