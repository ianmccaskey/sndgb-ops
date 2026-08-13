/**
 * fetch with backoff for rate limits and transient upstream failures.
 *
 * Retries 429 and transient 5xx responses — honoring a Retry-After header
 * when the provider sends one — with exponential backoff and jitter, so a
 * bulk verify run rides out Helius/Moralis rate limits instead of failing
 * each row. Network-level throws (connection reset, DNS blip, dropped
 * proxy) get the same bounded retries — the callers only use this for
 * idempotent chain-state lookups — with the last error rethrown so
 * callers keep their own connectivity messaging.
 */

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.min(Math.max(at - Date.now(), 0), 30_000) : null;
}

export async function fetchWithBackoff(
  input: RequestInfo | URL,
  init?: RequestInit,
  attempts = 5,
): Promise<Response> {
  let delay = 600;
  for (let i = 1; ; i++) {
    let res: Response | null = null;
    try {
      res = await fetch(input, init);
    } catch (e) {
      if (i >= attempts) throw e;
    }
    if (res && (!RETRYABLE.has(res.status) || i >= attempts)) return res;
    await sleep((res && retryAfterMs(res)) ?? Math.round(delay * (1 + Math.random() * 0.25)));
    delay = Math.min(delay * 2, 8_000);
  }
}
